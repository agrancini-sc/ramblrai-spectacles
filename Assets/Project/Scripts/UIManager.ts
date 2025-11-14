import { BaseButton } from "SpectaclesUIKit.lspkg/Scripts/Components/Button/BaseButton"

@component
export class UIManager extends BaseScriptComponent {
    @input
    introPanel: SceneObject

    @input
    stepsPanel: SceneObject

    @input
    aiAssistantPanel: SceneObject

    @input
    spatialCluePanel: SceneObject

    @input
    hintPanel: SceneObject

    @input
    getStartedButton: BaseButton

    @input
    closeButton: BaseButton

    @input
    @allowUndefined
    iUnderstandButton: BaseButton

    onAwake() {
        this.createEvent("OnStartEvent").bind(() => {
            this.showIntroState()
            this.bindButtonHandlers()
        })
    }

    private bindButtonHandlers() {
        this.bindButton(this.getStartedButton, this.handleGetStarted, "Get Started button")
        this.bindButton(this.closeButton, this.handleReturnToIntro, "Close button")
        this.bindButton(this.iUnderstandButton, this.handleHintAcknowledged, "I Understand button")
    }

    private bindButton(button: BaseButton, handler: () => void, description: string) {
        if (button && button.onTriggerUp) {
            button.onTriggerUp.add(handler)
        } else {
            print(`[UIManager] ${description} is not assigned or missing onTriggerUp`)
        }
    }

    private handleGetStarted = () => {
        this.setPanelEnabled(this.introPanel, false)
        this.setPanelEnabled(this.hintPanel, true)
        this.setPanelEnabled(this.stepsPanel, false)
        this.setPanelEnabled(this.aiAssistantPanel, false)
        this.setPanelEnabled(this.spatialCluePanel, true)
    }

    private handleReturnToIntro = () => {
        this.showIntroState()
    }

    private handleHintAcknowledged = () => {
        this.setPanelEnabled(this.hintPanel, false)
        this.setPanelEnabled(this.stepsPanel, true)
        this.setPanelEnabled(this.aiAssistantPanel, true)
        this.setPanelEnabled(this.spatialCluePanel, true)
    }

    private showIntroState() {
        this.setPanelEnabled(this.introPanel, true)
        this.setMainPanelsEnabled(false)
        this.setPanelEnabled(this.hintPanel, false)
    }

    private setMainPanelsEnabled(enabled: boolean) {
        this.setPanelEnabled(this.stepsPanel, enabled)
        this.setPanelEnabled(this.aiAssistantPanel, enabled)
        this.setPanelEnabled(this.spatialCluePanel, enabled)
    }

    private setPanelEnabled(panel: SceneObject, enabled: boolean) {
        if (panel) {
            panel.enabled = enabled
        } else {
            print("[UIManager] Panel reference missing")
        }
    }
}

