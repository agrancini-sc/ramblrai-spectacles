import { BaseButton } from "SpectaclesUIKit.lspkg/Scripts/Components/Button/BaseButton"
import { ToggleGroup } from "SpectaclesUIKit.lspkg/Scripts/Components/Toggle/ToggleGroup"

const CameraModule = require("LensStudio:CameraModule")
const InternetModule = require("LensStudio:InternetModule")

type ScreenVertex = {
    x: number
    y: number
}

type DetectionPayload = {
    label?: string
    confidence?: number
    vertices?: ScreenVertex[]
    raw?: any
}

type InstructionPayload = {
    instructionIndex: number
    description: string
    status?: string
    raw?: any
}

@component
export class RamblrStreamManager extends BaseScriptComponent {
    // Authentication inputs (kept private to avoid inspector exposure)
    // SECURITY: Configure these values from environment variables or secure configuration
    // See ramblr-config.json, ramblr-config.py, or ramblr.env.example for your credentials

    private readonly clientId: string = "YOUR_CLIENT_ID_HERE"

    private readonly clientSecret: string = "YOUR_CLIENT_SECRET_HERE"

    private readonly authority: string = "https://ramblrcustomers.ciamlogin.com/YOUR_TENANT_ID_HERE"

    private readonly scope: string = "YOUR_CLIENT_ID_HERE/.default"

    // Service routing inputs
    // Workspace UUID for the Ramblr session
    private workspaceId: string = "YOUR_WORKSPACE_ID_HERE"

    // Optional skill identifier to target downstream orchestration
    // Example: Emblem Maintenance skill
    private skillId: string = "YOUR_SKILL_ID_HERE"

    // WebSocket base URL exposed by Ramblr service
    // Base URL - will append /sessions/ws path
    private websocketUrl: string = "wss://backend.c7374.ramblr.ai/rocket/interface_test/v1"

    // Optional HTTPS base URL when distinct from authority host
    private apiBaseUrl: string

    // Camera tuning
    @input
    @hint("Request still frames every N milliseconds")
    targetFrameRate: number = 3

    @input
    @hint("Camera smaller dimension (pixels). Leave 0 to use default")
    imageSmallerDimension: number = 756

    // Encoding preferences
    @input
    @hint("Encode frames as PNG instead of JPEG")
    usePngEncoding: boolean = false

    @input
    @hint("JPEG quality 0-1 (ignored for PNG)")
    jpegQuality: number = 0.82

    // Logging & throttles
    @input
    @hint("Enable verbose logging to the Lens Studio console")
    verboseLogging: boolean = false

    @input
    @hint("Maximum number of encode operations in flight")
    maxConcurrentEncodes: number = 2

    @input
    @allowUndefined
    @hint("Optional texture to stream instead of the live camera (e.g. video preview)")
    videoFrameTexture: Texture

    @input
    @allowUndefined
    @hint("Toggle group that highlights the current step")
    stepToggleGroup: ToggleGroup

    @input
    @allowUndefined
    @hint("Optional explicit ordered list of step buttons")
    stepToggleButtons: BaseButton[] = []

    @input
    @allowUndefined
    @hint("Ordered text components for each visible step page")
    stepTexts: Text[] = []

    @input
    @allowUndefined
    @hint("Optional text components used to show the numeric step labels")
    stepNumberTexts: Text[] = []

    @input
    @allowUndefined
    @hint("Displays the latest AI query (optional)")
    aiQueryText: Text

    @input
    @allowUndefined
    @hint("Displays the latest AI response (optional)")
    aiResponseText: Text

    // Notification wiring
    @input
    @allowUndefined
    @hint("Scripts to notify when new detections arrive")
    detectionTargets: ScriptComponent[]

    @input
    @allowUndefined
    @hint("Function names on detection targets to invoke")
    detectionFunctions: string[]

    @input
    @allowUndefined
    @hint("Scripts to notify when instruction updates arrive")
    instructionTargets: ScriptComponent[]

    @input
    @allowUndefined
    @hint("Function names on instruction targets to invoke")
    instructionFunctions: string[]

    private internetModule = InternetModule
    private cameraTexture: Texture
    private cameraTextureProvider: CameraTextureProvider
    private onFrameHandler: (frame: CameraFrame) => void
    private onFrameRegistration: any
    private trackingCamera: DeviceCamera
    private websocket: WebSocket

    private accessToken: string
    private tokenExpiresAt: number = 0
    private tokenRefreshEvent: DelayedCallbackEvent

    private lastFrameSentTs: number = 0
    private frameIntervalMs: number = 0
    private inflightEncodes: number = 0
    private frameCounter: number = 0

    private frameWidth: number = 0
    private frameHeight: number = 0

    private latestDetections: DetectionPayload[] = []
    private latestInstruction: InstructionPayload = null

    private cameraReady: boolean = false
    private socketReady: boolean = false
    private pendingSessionHello: boolean = false
    private authMethod: number = 0  // Track which authentication method to try
    private maxAuthAttempts: number = 5  // Number of different auth methods to try
    
    // Send queue to prevent message corruption
    private isSending: boolean = false
    private sendQueue: string[] = []
    
    private processId: string
    private instructionCatalog: InstructionPayload[] = []
    private currentInstructionIndex: number = -1
    private visibleInstructionPageStart: number = 0
    private instructionFetchInFlight: boolean = false
    private readonly instructionsPerPage: number = 8

    onAwake() {
        this.frameIntervalMs = Math.max(1, Math.floor(1000 / Math.max(1, this.targetFrameRate)))

        this.createEvent("OnStartEvent").bind(() => {
            this.initialize()
        })

        this.createEvent("OnDestroyEvent").bind(() => {
            this.shutdown()
        })
    }

    private async initialize() {
        if (!this.validateConfig()) {
            return
        }

        try {
            if (!this.usingVideoFrameSource()) {
            await this.setupCamera()
            } else {
                this.initializeVideoFrameSource()
            }
            await this.ensureAccessToken()
            // Reset auth method for fresh start
            this.authMethod = 0
            this.openWebSocket()
        } catch (error) {
            this.logError("Initialization failed", error)
        }
    }

    private validateConfig(): boolean {
        const missing: string[] = []
        if (!this.clientId) missing.push("clientId")
        if (!this.clientSecret) missing.push("clientSecret")
        if (!this.authority) missing.push("authority")
        if (!this.scope) missing.push("scope")
        if (!this.workspaceId) missing.push("workspaceId")
        if (!this.websocketUrl) missing.push("websocketUrl")

        if (missing.length > 0) {
            this.logError("Missing configuration inputs: " + missing.join(", "))
            return false
        }

        if (!this.apiBaseUrl) {
            this.apiBaseUrl = this.authority
        }

        if (this.jpegQuality <= 0 || this.jpegQuality > 1) {
            this.jpegQuality = 0.82
        }

        return true
    }

    private async setupCamera(): Promise<void> {
        if (this.cameraReady) {
            return
        }

        const cameraRequest = CameraModule.createCameraRequest()
        cameraRequest.cameraId = CameraModule.CameraId.Default_Color
        if (this.imageSmallerDimension > 0) {
            cameraRequest.imageSmallerDimension = this.imageSmallerDimension
        }

        this.cameraTexture = CameraModule.requestCamera(cameraRequest)
        if (!this.cameraTexture) {
            throw new Error("Failed to request camera texture")
        }

        this.cameraTextureProvider = this.cameraTexture.control as CameraTextureProvider
        if (!this.cameraTextureProvider) {
            throw new Error("Unable to acquire CameraTextureProvider")
        }

        const cameraDevice = global.deviceInfoSystem.getTrackingCameraForId(cameraRequest.cameraId)
        if (cameraDevice && cameraDevice.resolution) {
            this.frameWidth = cameraDevice.resolution.x
            this.frameHeight = cameraDevice.resolution.y
        }

        this.onFrameHandler = (frame: CameraFrame) => {
            this.handleCameraFrame()
        }

        this.onFrameRegistration = this.cameraTextureProvider.onNewFrame.add(this.onFrameHandler)

        this.cameraReady = true
        this.log(`Live camera initialized: ${this.frameWidth}x${this.frameHeight}`)
        this.log(`Frame capture will start at ${this.targetFrameRate} fps (${this.frameIntervalMs}ms interval)`)
    }

    private async ensureAccessToken(): Promise<void> {
        const now = getTime()
        if (this.accessToken && now < this.tokenExpiresAt - 30) {
            this.log("Access token still valid, skipping refresh")
            return
        }

        const tokenUrl = `${this.authority.replace(/\/$/, "")}/oauth2/v2.0/token`
        const body = `client_id=${encodeURIComponent(this.clientId)}&client_secret=${encodeURIComponent(this.clientSecret)}&scope=${encodeURIComponent(this.scope)}&grant_type=client_credentials`

        this.log("Requesting access token from:", tokenUrl)
        this.log("Token request params: client_id=" + this.clientId + ", scope=" + this.scope)

        const response = await this.internetModule.fetch(tokenUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body,
        })

        if (!response) {
            throw new Error("Token request failed: no response")
        }

        // InternetModule may return undefined statusCode on errors
        const statusCode = response.statusCode !== undefined ? response.statusCode : (response.status || 0)
        this.log(`Token response status: ${statusCode}`)

        const responseText =
            typeof (response as any).text === "function"
                ? await (response as any).text()
                : response.body !== undefined
                    ? response.body
                    : ""

        // Check for error status codes
        if (statusCode === 401) {
            this.logError("Authentication failed: Invalid client_id or client_secret")
            this.logError("Please verify your credentials in the RamblrStreamManager component")
            throw new Error("Token request failed: 401 Unauthorized - Invalid credentials")
        }

        if (statusCode !== 0 && (statusCode < 200 || statusCode >= 300)) {
            const errorDetail = responseText ? ` body=${responseText}` : ""
            this.logError(`Token request failed with status ${statusCode}${errorDetail}`)
            throw new Error(`Token request failed with status ${statusCode}${errorDetail}`)
        }

        if (!responseText) {
            throw new Error("Token request returned empty body (this may indicate a 401 or network error)")
        }

        let payload: any
        try {
            payload = JSON.parse(responseText)
        } catch (error) {
            this.logError("Failed to parse token response. This may indicate authentication failure.")
            throw new Error(`Token response parse error :: ${(error as Error).message || error}`)
        }

        this.accessToken = payload.access_token
        
        // Validate and trim token
        if (!this.accessToken || typeof this.accessToken !== 'string') {
            this.logError("No access_token in response. Check client credentials and authority URL.")
            throw new Error("Invalid access token received from server - credentials may be incorrect")
        }
        
        // Trim any whitespace
        this.accessToken = this.accessToken.trim()
        
        const expiresIn = payload.expires_in ? parseInt(payload.expires_in, 10) : 3600
        this.tokenExpiresAt = getTime() + expiresIn

        // Log token info (first/last few chars for security)
        const tokenPreview = this.accessToken.length > 20 
            ? `${this.accessToken.substring(0, 10)}...${this.accessToken.substring(this.accessToken.length - 10)}`
            : "***"
        this.log(`Received access token (${this.accessToken.length} chars): ${tokenPreview}; expires in ${expiresIn} seconds`)
        
        this.scheduleTokenRefresh(Math.max(60, expiresIn - 120))
    }

    private scheduleTokenRefresh(delaySeconds: number) {
        if (!this.tokenRefreshEvent) {
            this.tokenRefreshEvent = this.createEvent("DelayedCallbackEvent")
            this.tokenRefreshEvent.bind(() => {
                this.refreshToken()
            })
        }

        this.tokenRefreshEvent.reset(delaySeconds)
    }

    private async refreshToken() {
        this.log("Refreshing access token")
        try {
            this.accessToken = null
            await this.ensureAccessToken()
        } catch (error) {
            this.logError("Token refresh failed", error)
        }
    }

    private openWebSocket() {
        if (this.websocket) {
            this.websocket.close()
            this.websocket = null
        }

        const url = this.buildWebSocketUrl()
        
        // Try different authentication methods
        this.log(`\n========== AUTH METHOD ${this.authMethod + 1}/${this.maxAuthAttempts} ==========`)
        
        try {
            switch (this.authMethod) {
                case 0:
                    // Method 1: Single protocol string (WORKING VERSION FORMAT!)
                    this.log("METHOD 1: Single protocol string (KNOWN WORKING)")
                    this.log("Format: 'Authorization, Bearer-...'")
                    const protocol1 = `Authorization, Bearer-${this.accessToken}`
                    this.websocket = this.internetModule.createWebSocket(url, protocol1 as any)
                    break

                case 1:
                    // Method 2: Array of protocol strings
                    this.log("METHOD 2: Array of protocol strings")
                    this.log("Format: ['Authorization', 'Bearer-...']")
                    const protocols2 = ["Authorization", `Bearer-${this.accessToken}`]
                    this.websocket = this.internetModule.createWebSocket(url, protocols2 as any)
                    break

                case 2:
                    // Method 3: Headers object with sec-websocket-protocol
                    this.log("METHOD 3: Headers object with sec-websocket-protocol")
                    const subprotocol3 = `Authorization, Bearer-${this.accessToken}`
                    this.log("Format: { headers: { 'sec-websocket-protocol': 'Authorization, Bearer-...' } }")
                    this.websocket = this.internetModule.createWebSocket(url, {
                        headers: {
                            'sec-websocket-protocol': subprotocol3
                        }
                    } as any)
                    break

                case 3:
                    // Method 4: Token in URL query parameter
                    this.log("METHOD 4: Token as URL query parameter")
                    const authUrl = url.indexOf('?') >= 0
                        ? `${url}&access_token=${encodeURIComponent(this.accessToken)}`
                        : `${url}?access_token=${encodeURIComponent(this.accessToken)}`
                    this.log("Format: URL + '?access_token=...'")
                    this.websocket = this.internetModule.createWebSocket(authUrl)
                    break

                case 4:
                    // Method 5: No auth in handshake
                    this.log("METHOD 5: No auth in handshake")
                    this.log("Format: Plain connection")
                    this.websocket = this.internetModule.createWebSocket(url)
                    break

                default:
                    this.logError("All authentication methods exhausted")
                    return
            }

            this.websocket.binaryType = "blob"
            this.log("WebSocket object created, waiting for events...")
        } catch (error) {
            this.logError(`Method ${this.authMethod + 1} failed to create websocket`, error)
            this.tryNextAuthMethod()
            return
        }

        this.websocket.onopen = () => {
            this.log("SUCCESS! Websocket connection established!")
            this.log(`Authentication method ${this.authMethod + 1} WORKED!`)
            this.log("WebSocket readyState:", this.websocket.readyState)
            this.socketReady = true
            // NO session_start message needed! Server sends session_init automatically
            // Just wait for session_init from server, then start sending frames
            this.log("Waiting for session_init from server...")
        }

        this.websocket.onmessage = (event) => {
            this.log("Websocket message received", typeof event.data)
            this.handleSocketMessage(event.data)
        }

        this.websocket.onerror = (event) => {
            this.logError(`Method ${this.authMethod + 1} - Websocket error occurred`)
        }

        this.websocket.onclose = (event) => {
            const code = event ? event.code : "unknown"
            const reason = event && event.reason ? event.reason : "no reason"
            const wasClean = event ? event.wasClean : false
            
            // Clear send queue on close
            this.sendQueue = []
            this.isSending = false
            
            // Check if connection was ever established
            if (!this.socketReady) {
                this.log(`Method ${this.authMethod + 1} FAILED - closed before onopen (code: ${code})`)
                this.tryNextAuthMethod()
                return
            }
            
            // Connection was established but then closed
            this.log(`Websocket closed after successful connection - code: ${code}, reason: "${reason}", wasClean: ${wasClean}`)
            
            this.socketReady = false
            this.pendingSessionHello = false
            
            // Reconnect on abnormal closures using the working method
            if (!wasClean || (code !== 1000 && code !== 1001)) {
                this.scheduleReconnect()
            }
        }
    }

    private tryNextAuthMethod() {
        this.authMethod++
        if (this.authMethod >= this.maxAuthAttempts) {
            this.logError("All authentication methods failed")
            this.logError("Please contact Ramblr support with these logs")
            return
        }
        
        this.log(`Trying next authentication method in 2 seconds...`)
        const retryEvent = this.createEvent("DelayedCallbackEvent")
        retryEvent.bind(() => {
            this.openWebSocket()
        })
        retryEvent.reset(2)
    }

    private buildWebSocketUrl(): string {
        // Use the working format: /sessions/ws?workspace_id=...&skill_id=...
        const baseUrl = this.websocketUrl.replace(/\/$/, "")  // Remove trailing slash if present
        let url = `${baseUrl}/sessions/ws?workspace_id=${encodeURIComponent(this.workspaceId)}`
        
        // Add skill_id if provided (Week 4: "needs set with starting the websocket")
        if (this.skillId && this.skillId.length > 0) {
            url += `&skill_id=${encodeURIComponent(this.skillId)}`
            this.log("Building WebSocket URL with skill_id:", this.skillId)
        }
        
        this.log("Final WebSocket URL:", url)
        return url
    }

    private scheduleReconnect() {
        const reconnectEvent = this.createEvent("DelayedCallbackEvent")
        reconnectEvent.bind(() => {
            this.openWebSocket()
        })
        reconnectEvent.reset(3)
    }

    // NOTE: session_start is NOT a valid message type according to the OpenAPI spec!
    // The server automatically sends session_init after websocket connection.
    // No client-initiated session message is needed.
    // 
    // private sendSessionHello() {
    //     ... removed ...
    // }

    private handleCameraFrame() {
        if (!this.cameraTexture || !this.shouldSendFrame()) {
            return
        }
        const frameTexture = this.cameraTexture.copyFrame()
        this.encodeAndDispatchFrame(frameTexture)
    }

    private qualityToEnum(quality: number): CompressionQuality {
        if (quality >= 0.85) {
            return CompressionQuality.HighQuality
        }
        if (quality >= 0.65) {
            return CompressionQuality.IntermediateQuality
        }
        return CompressionQuality.LowQuality
    }

    private dispatchFrame(base64Image: string) {
        if (!this.socketReady) {
            return
        }

        const frameId = ++this.frameCounter
        const sizeKb = Math.round(base64Image.length * 0.75 / 1024)
        
        // Use "image_data" type as in working version
        const payload = {
            type: "image_data",
            frame_correlation_id: `${frameId}`,
            content_type: this.usePngEncoding ? "image/png" : "image/jpeg",
            width: this.frameWidth,
            height: this.frameHeight,
            size: base64Image.length,
            base64_image: base64Image,
            expecting_binary: false,
        }

        this.log(`Sending frame ${frameId} (${sizeKb}kb, ${this.frameWidth}x${this.frameHeight})`)
        
        // Show frame rate
        if (frameId % 10 === 0) {
            this.log(`${frameId} frames sent so far`)
        }
        
        this.sendJson(payload)
    }

    private sendJson(message: any) {
        if (!this.socketReady || !this.websocket) {
            return
        }

        try {
            const serialized = JSON.stringify(message)
            // Use queue to prevent message corruption (from working version)
            this.queueSend(serialized)
            this.log("Queued message", message.type, `(${serialized.length} chars)`)
        } catch (error) {
            this.logError("Failed to serialize message", error)
        }
    }

    private queueSend(message: string) {
        this.sendQueue.push(message)
        if (!this.isSending) {
            this.processSendQueue()
        }
    }

    private processSendQueue() {
        if (this.sendQueue.length === 0) {
            this.isSending = false
            return
        }

        if (!this.websocket || this.websocket.readyState !== 1) {
            this.isSending = false
            this.sendQueue = []
            this.logError("WebSocket not open, clearing send queue")
            return
        }

        this.isSending = true
        const message = this.sendQueue.shift()

        try {
            this.websocket.send(message)
            this.log(`Message sent (${message.length} chars)`)
        } catch (error) {
            this.logError("WebSocket send error", error)
        }

        // Delay before sending next message (from working version)
        const delayedEvent = this.createEvent("DelayedCallbackEvent")
        delayedEvent.bind(() => {
            this.processSendQueue()
        })
        delayedEvent.reset(0.05) // 50ms delay between messages
    }

    private handleSocketMessage(data: string | Blob) {
        if (!data) {
            return
        }

        let serialized: string
        if (typeof data === "string") {
            serialized = data
        } else {
            serialized = ""
        }

        if (!serialized) {
            return
        }

        let payload: any
        try {
            payload = JSON.parse(serialized)
        } catch (error) {
            this.logError("Websocket payload parse error", error)
            return
        }

        if (!payload) {
            return
        }

        const msgType = payload.type
        this.log(`Received message type: ${msgType}`)

        // Handle different message types from working version
        switch (msgType) {
            case "session_init":
                this.log("Session initialized by server!")
                this.log("Session data:", JSON.stringify(payload))
                
                // Check if process is active
                if (payload.process_id) {
                    this.log(`Process active: ${payload.process_id}`)
                    if (payload.current_process_state) {
                        this.log(`Current state: ${payload.current_process_state.state_name}`)
                    }
                } else {
                    this.logError("No active process! process_id is null")
                    this.logError(`Check Ramblr dashboard - skill_id ${this.skillId} may need configuration`)
                    this.logError("Without an active process, you won't receive instructions/feedback")
                }
                
                if (this.aiResponseText) {
                    const statusText = payload.process_id 
                        ? "Session active, processing frames..."
                        : "Connected (no active process)"
                    this.aiResponseText.text = statusText
                }
                // Now that session is initialized, we can start sending frames
                // Camera/video should already be running from initialize()
                break

            case "frame_detection":
                // Object detections in frame
                const detections = this.getDetections(payload)
                if (detections.length > 0) {
                    this.latestDetections = detections
                    this.notifyDetections(detections)
                    let detText = `Detected:\n`
                    detections.forEach((det, i) => {
                        detText += `${i+1}. ${det.label}\n`
                    })
                    if (this.aiResponseText) {
                        this.aiResponseText.text = detText
                    }
                }
                break

            case "session_feedback":
                // Instructions/feedback
                this.log(`Session feedback received - type: ${payload.feedback_type}`)
                this.log(`Feedback data: ${JSON.stringify(payload.data)}`)
                
                const instruction = this.getInstruction(payload)
                if (instruction) {
                    this.latestInstruction = instruction
                    this.notifyInstructions(instruction)
                    if (this.aiResponseText) {
                        this.aiResponseText.text = instruction.description
                        this.log(`Updated UI text: ${instruction.description.substring(0, 50)}...`)
                    }
                } else {
                    // Direct feedback without instruction structure
                    const feedbackText = JSON.stringify(payload.data)
                    this.log(`Direct feedback: ${feedbackText}`)
                    if (this.aiResponseText) {
                        this.aiResponseText.text = feedbackText
                    }
                }
                break

            case "session_process_state_changed":
                // Process state updates
                const stateName = payload.process_state_name || "unknown"
                this.log(`State changed to: ${stateName}`)
                if (this.aiResponseText) {
                    this.aiResponseText.text = `State: ${stateName}`
                }
                break

            case "message":
                // Chat/AI messages
                const content = payload.content || ""
                const isComplete = payload.message_complete || false
                this.log(`AI message: ${content.substring(0, 100)}... (complete: ${isComplete})`)
                if (isComplete) {
                    if (this.aiResponseText) {
                        this.aiResponseText.text = content
                        this.log(`Updated UI with AI response (${content.length} chars)`)
                    }
                } else {
                    // Partial message - could update in real-time for streaming effect
                    if (this.aiResponseText) {
                        this.aiResponseText.text = content + "..."
                    }
                }
                break

            case "meta":
                // Meta messages
                this.log(`Meta: ${payload.content || ""}`)
                break

            case "error":
                // Error messages from server
                const errorMsg = payload.message || payload.error || payload.content || JSON.stringify(payload)
                this.logError(`Server error: ${errorMsg}`)
                this.logError(`Full error payload: ${JSON.stringify(payload)}`)
                if (this.aiResponseText) {
                    this.aiResponseText.text = `Error: ${errorMsg}`
                }
                break

            default:
                this.log(`Unhandled message type: ${msgType}`)
                this.log(`Full payload: ${JSON.stringify(payload)}`)
                break
        }

        this.tryHarvestProcessId(payload)
        this.updateInstructionCatalogFromPayload(payload)
    }

    private getDetections(payload: any): DetectionPayload[] {
        // Working version uses "objects" field for frame_detection messages
        const source = payload.objects || payload.detections || payload.frame_feedback?.detections || []
        const detections: DetectionPayload[] = []
        for (let i = 0; i < source.length; i++) {
            const det = source[i]
            const detection: DetectionPayload = {
                label: det.label || det.classification,
                confidence: det.confidence,
                vertices: this.extractVertices(det),
                raw: det,
            }
            detections.push(detection)
        }
        return detections
    }

    private extractVertices(det: any): ScreenVertex[] {
        if (!det) {
            return []
        }

        if (det.screen_vertices && det.screen_vertices.length) {
            return det.screen_vertices.map((p) => ({ x: p.x, y: p.y }))
        }

        if (det.vertices && det.vertices.length) {
            return det.vertices.map((p) => ({ x: p.x, y: p.y }))
        }

        if (det.bounding_box) {
            const box = det.bounding_box
            const left = box.x || 0
            const top = box.y || 0
            const width = box.width || 0
            const height = box.height || 0
            return [
                { x: left, y: top },
                { x: left + width, y: top },
                { x: left + width, y: top + height },
                { x: left, y: top + height },
            ]
        }

        return []
    }

    private getInstruction(payload: any): InstructionPayload {
        // Working version uses "data" field for session_feedback
        const source = payload.data || payload.current_instruction || payload.instruction
        if (!source) {
            return null
        }

        // Handle if source is a string (direct feedback text)
        if (typeof source === 'string') {
            return {
                instructionIndex: 0,
                description: source,
                status: undefined,
                raw: payload,
            }
        }

        // Handle object format
        const instruction: InstructionPayload = {
            instructionIndex: source.index || source.step_index || 0,
            description: source.text || source.description || JSON.stringify(source),
            status: source.status || source.state,
            raw: source,
        }

        return instruction
    }

    private notifyDetections(detections: DetectionPayload[]) {
        this.log("Dispatching detections", detections.length)
        const targets = this.detectionTargets || []
        const handlers = this.detectionFunctions || []
        for (let i = 0; i < targets.length; i++) {
            const script = targets[i]
            const fn = handlers[i] || handlers[0]
            if (script && fn && script.api && typeof script.api[fn] === "function") {
                try {
                    script.api[fn](detections)
                } catch (error) {
                    this.logError("Detection handler threw", error)
                }
            }
        }
    }

    private notifyInstructions(instruction: InstructionPayload) {
        this.log("Dispatching instruction", instruction.instructionIndex, instruction.description)
        const targets = this.instructionTargets || []
        const handlers = this.instructionFunctions || []
        for (let i = 0; i < targets.length; i++) {
            const script = targets[i]
            const fn = handlers[i] || handlers[0]
            if (script && fn && script.api && typeof script.api[fn] === "function") {
                try {
                    script.api[fn](instruction)
                } catch (error) {
                    this.logError("Instruction handler threw", error)
                }
            }
        }
        this.handleInstructionChanged(instruction)
    }

    private shutdown() {
        if (this.websocket) {
            try {
                this.websocket.close()
            } catch (error) {
                // Ignore close errors
            }
            this.websocket = null
        }

        if (this.cameraTextureProvider && this.onFrameRegistration) {
            try {
                this.cameraTextureProvider.onNewFrame.remove(this.onFrameRegistration)
            } catch (error) {
                // ignore removal errors
            }
            this.onFrameRegistration = null
            this.onFrameHandler = null
        }

        // Clear send queue
        this.sendQueue = []
        this.isSending = false

        this.cameraReady = false
        this.socketReady = false
    }

    private log(message: string, ...args: any[]) {
        if (this.verboseLogging) {
            print(`[RamblrStreamManager] ${message}` + (args.length ? " " + JSON.stringify(args) : ""))
        }
    }

    private logError(message: string, error?: any) {
        let detail = ""
        if (error) {
            if (error instanceof Error) {
                detail = ` :: ${error.message}`
                if (error.stack && this.verboseLogging) {
                    detail += `\n${error.stack}`
                }
            } else if (typeof error === "string") {
                detail = ` :: ${error}`
            } else {
                try {
                    detail = ` :: ${JSON.stringify(error)}`
                } catch (_jsonError) {
                    detail = " :: [unserializable error]"
                }
            }
        }
        print(`[RamblrStreamManager][Error] ${message}${detail}`)
    }

    public getLatestDetections(): DetectionPayload[] {
        return this.latestDetections
    }

    public getLatestInstruction(): InstructionPayload {
        return this.latestInstruction
    }

    private usingVideoFrameSource(): boolean {
        const isVideo = this.videoFrameTexture !== undefined && this.videoFrameTexture !== null
        this.log(`Frame source: ${isVideo ? "Video texture" : "Live camera"}`)
        return isVideo
    }

    private initializeVideoFrameSource() {
        if (!this.usingVideoFrameSource()) {
            return
        }
        this.frameWidth = this.safeGetTextureDimension(this.videoFrameTexture, true)
        this.frameHeight = this.safeGetTextureDimension(this.videoFrameTexture, false)
        this.cameraReady = true

        this.log(`Video frame source initialized: ${this.frameWidth}x${this.frameHeight}`)
        this.log(`Starting frame capture at ${this.targetFrameRate} fps`)

        const updateEvent = this.createEvent("UpdateEvent")
        updateEvent.bind(() => {
            this.handleManualFrameTick()
        })
    }

    private safeGetTextureDimension(texture: Texture, width: boolean): number {
        if (!texture) {
            return 0
        }
        try {
            return width ? texture.getWidth() : texture.getHeight()
        } catch (error) {
            this.logError("Failed to read texture dimension", error)
            return 0
        }
    }

    private handleManualFrameTick() {
        if (!this.usingVideoFrameSource()) {
            return
        }
        if (!this.shouldSendFrame()) {
            return
        }
        this.encodeAndDispatchFrame(this.videoFrameTexture)
    }

    private shouldSendFrame(): boolean {
        if (!this.socketReady || !this.accessToken) {
            if (this.frameCounter === 0) {
                this.log("Not sending frames: socket not ready or no token")
            }
            return false
        }

        const now = getTime()
        if (now - this.lastFrameSentTs < this.frameIntervalMs) {
            return false  // Too soon, throttling
        }

        if (this.inflightEncodes >= this.maxConcurrentEncodes) {
            this.log(`Throttling: ${this.inflightEncodes} encodes in flight`)
            return false
        }

        return true
    }

    private encodeAndDispatchFrame(frameTexture: Texture) {
        if (!frameTexture) {
            return
        }

        this.inflightEncodes++
        const compressionQuality = this.usePngEncoding ? CompressionQuality.HighQuality : this.qualityToEnum(this.jpegQuality)
        const encodingFormat = this.usePngEncoding ? EncodingType.Png : EncodingType.Jpg

        Base64.encodeTextureAsync(
            frameTexture,
            (base64String: string) => {
                this.inflightEncodes = Math.max(0, this.inflightEncodes - 1)
                this.lastFrameSentTs = getTime()
                this.dispatchFrame(base64String)
            },
            () => {
                this.inflightEncodes = Math.max(0, this.inflightEncodes - 1)
                this.logError("Failed to encode frame")
            },
            compressionQuality,
            encodingFormat
        )
    }

    private tryHarvestProcessId(payload: any) {
        if (this.processId) {
            return
        }
        const candidate =
            payload?.process_id ||
            payload?.processId ||
            payload?.process?.id ||
            payload?.session?.process_id ||
            payload?.session?.id
        if (candidate) {
            this.processId = candidate
            this.fetchProcessInstructions(candidate)
        }
    }

    private updateInstructionCatalogFromPayload(payload: any) {
        if (!payload) {
            return
        }
        const instructionSource =
            payload.instructions ||
            payload.current_instructions ||
            payload.process?.instructions ||
            payload.session?.instructions
        if (instructionSource && instructionSource.length) {
            const normalized = this.normalizeInstructions(instructionSource)
            this.setInstructionCatalog(normalized)
        }
    }

    private normalizeInstructions(source: any[]): InstructionPayload[] {
        if (!Array.isArray(source)) {
            return []
        }
        return source.map((item, index) => ({
            instructionIndex: item?.index ?? item?.step_index ?? index,
            description: item?.text ?? item?.description ?? "",
            status: item?.status ?? item?.state,
            raw: item,
        }))
    }

    private setInstructionCatalog(instructions: InstructionPayload[]) {
        if (!instructions || instructions.length === 0) {
            this.instructionCatalog = []
            this.visibleInstructionPageStart = 0
            this.refreshInstructionUI()
            return
        }

        this.instructionCatalog = instructions.slice().sort((a, b) => a.instructionIndex - b.instructionIndex)

        if (this.currentInstructionIndex >= 0) {
            this.updateVisiblePageForIndex(this.currentInstructionIndex)
        } else if (this.instructionCatalog.length > 0) {
            this.updateVisiblePageForIndex(this.instructionCatalog[0].instructionIndex)
        }

        this.refreshInstructionUI()
    }

    private handleInstructionChanged(instruction: InstructionPayload) {
        if (!instruction) {
            this.currentInstructionIndex = -1
            this.refreshInstructionUI()
            return
        }

        const explicitIndex =
            instruction.instructionIndex !== undefined && instruction.instructionIndex !== null
                ? instruction.instructionIndex
                : this.findInstructionIndex(instruction)

        this.currentInstructionIndex = explicitIndex
        if (this.currentInstructionIndex >= 0) {
            this.updateVisiblePageForIndex(this.currentInstructionIndex)
        }
        this.refreshInstructionUI()
    }

    private findInstructionIndex(instruction: InstructionPayload): number {
        if (!this.instructionCatalog || this.instructionCatalog.length === 0) {
            return -1
        }
        const raw = instruction.raw
        if (raw) {
            for (let i = 0; i < this.instructionCatalog.length; i++) {
                const candidate = this.instructionCatalog[i]
                if (candidate.raw && candidate.raw.id && raw.id && candidate.raw.id === raw.id) {
                    return candidate.instructionIndex
                }
            }
        }
        // fallback by matching text
        for (let i = 0; i < this.instructionCatalog.length; i++) {
            if (this.instructionCatalog[i].description === instruction.description) {
                return this.instructionCatalog[i].instructionIndex
            }
        }
        return -1
    }

    private updateVisiblePageForIndex(index: number) {
        if (index < 0) {
            return
        }
        const pageStart = Math.floor(index / this.instructionsPerPage) * this.instructionsPerPage
        this.visibleInstructionPageStart = pageStart
    }

    private refreshInstructionUI() {
        const buttons = this.getStepButtons()
        const activeIndex = this.currentInstructionIndex
        const pageStart = this.visibleInstructionPageStart
        const activeSlot = activeIndex >= 0 ? activeIndex - pageStart : -1

        for (let slot = 0; slot < this.instructionsPerPage; slot++) {
            const instruction = this.instructionCatalog[pageStart + slot]
            const hasInstruction = instruction !== undefined
            this.updateStepButtonState(buttons[slot], slot, hasInstruction, slot === activeSlot, pageStart)
            this.updateStepTextState(slot, instruction, slot === activeSlot, pageStart)
            this.updateStepNumberLabel(slot, instruction, pageStart)
        }

        if (activeSlot >= 0) {
            this.highlightStepSlot(activeSlot)
        }
    }

    private updateStepButtonState(button: BaseButton | undefined, slot: number, hasInstruction: boolean, isActive: boolean, pageStart: number) {
        if (!button) {
            return
        }
        const sceneObject = button.sceneObject
        if (sceneObject) {
            sceneObject.enabled = hasInstruction
        }
        if (!hasInstruction) {
            button.isOn = false
            return
        }

        if (isActive) {
            button.toggle(true)
        } else if (button.isOn) {
            button.toggle(false)
        }
    }

    private updateStepTextState(slot: number, instruction: InstructionPayload | undefined, isActive: boolean, pageStart: number) {
        if (!this.stepTexts || slot >= this.stepTexts.length) {
            return
        }
        const textComponent = this.stepTexts[slot]
        if (!textComponent) {
            return
        }

        if (instruction) {
            textComponent.text = instruction.description || ""
            textComponent.enabled = isActive
        } else {
            textComponent.text = ""
            textComponent.enabled = false
        }
    }

    private updateStepNumberLabel(slot: number, instruction: InstructionPayload | undefined, pageStart: number) {
        if (!this.stepNumberTexts || slot >= this.stepNumberTexts.length) {
            return
        }
        const label = this.stepNumberTexts[slot]
        if (!label) {
            return
        }
        if (instruction) {
            label.text = `${pageStart + slot + 1}`
            label.enabled = true
        } else {
            label.text = ""
            label.enabled = false
        }
    }

    private highlightStepSlot(activeSlot: number) {
        if (activeSlot < 0) {
            return
        }

        if (this.stepToggleGroup) {
            this.stepToggleGroup.firstOnToggle = activeSlot
            if (typeof (this.stepToggleGroup as any).resetToggleGroup === "function") {
                ;(this.stepToggleGroup as any).resetToggleGroup()
            }
            return
        }

        const buttons = this.getStepButtons()
        for (let i = 0; i < buttons.length; i++) {
            const button = buttons[i]
            if (!button) {
                continue
            }
            button.toggle(i === activeSlot)
        }
    }

    private getStepButtons(): BaseButton[] {
        if (this.stepToggleButtons && this.stepToggleButtons.length > 0) {
            return this.stepToggleButtons
        }
        if (this.stepToggleGroup && (this.stepToggleGroup as any).toggleables) {
            return ((this.stepToggleGroup as any).toggleables as BaseButton[]) || []
        }
        return []
    }

    private async fetchProcessInstructions(processId: string) {
        if (!processId || this.instructionFetchInFlight) {
            return
        }
        if (!this.internetModule || !this.apiBaseUrl) {
            return
        }
        this.instructionFetchInFlight = true
        try {
            await this.ensureAccessToken()
            const baseUrl = this.apiBaseUrl.replace(/\/$/, "")
            const url = `${baseUrl}/processes/${encodeURIComponent(processId)}`
            const response = await this.internetModule.fetch(url, {
                method: "GET",
                headers: {
                    Authorization: `Bearer ${this.accessToken}`,
                    Accept: "application/json",
                },
            })

            if (!response || response.statusCode < 200 || response.statusCode >= 300) {
                this.logError("Failed to fetch process instructions", response ? response.statusCode : "no response")
                return
            }

            let payload: any = null
            try {
                payload = JSON.parse(response.body)
            } catch (error) {
                this.logError("Failed to parse process response", error)
                return
            }

            if (!payload) {
                return
            }

            const instructionSource =
                payload.instructions || payload.process?.instructions || payload.data?.instructions || []
            if (instructionSource && instructionSource.length) {
                const normalized = this.normalizeInstructions(instructionSource)
                this.setInstructionCatalog(normalized)
            }
        } catch (error) {
            this.logError("Process fetch exception", error)
        } finally {
            this.instructionFetchInFlight = false
        }
    }
}
