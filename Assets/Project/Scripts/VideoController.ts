import { RectangleButton } from "SpectaclesUIKit.lspkg/Scripts/Components/Button/RectangleButton"
import { Slider } from "SpectaclesUIKit.lspkg/Scripts/Components/Slider/Slider"
import { VideoPlayback } from "./VideoPlayback"

@component
export class VideoController extends BaseScriptComponent {
    @input
    buttonPlay: RectangleButton

    @input
    buttonPause: RectangleButton

    @input
    buttonSeekForward: RectangleButton

    @input
    buttonSeekBackwards: RectangleButton

    @input
    sliderSeek: Slider

    @input
    videoPlayback: VideoPlayback

    private isPlaying: boolean = false
    private hasStarted: boolean = false

    onAwake() {
        this.createEvent("OnStartEvent").bind(() => {
            this.setupButtonEvents()
            this.setupSliderEvents()
        })
    }

    private setupButtonEvents() {
        // Play/Resume button
        if (this.buttonPlay && this.buttonPlay.onTriggerUp) {
            this.buttonPlay.onTriggerUp.add(() => {
                if (this.videoPlayback && !this.isPlaying) {
                    if (!this.hasStarted) {
                        // First time playing - use playVideo
                        this.videoPlayback.playVideo(1) // Play once
                        this.hasStarted = true
                    } else {
                        // Video was paused - use resumeVideo
                        this.videoPlayback.resumeVideo()
                    }
                    this.isPlaying = true
                }
            })
        } else {
            print("buttonPlay or its onTriggerUp event not available")
        }

        // Pause button
        if (this.buttonPause && this.buttonPause.onTriggerUp) {
            this.buttonPause.onTriggerUp.add(() => {
                if (this.isPlaying && this.videoPlayback) {
                    this.videoPlayback.pauseVideo()
                    this.isPlaying = false
                }
            })
        } else {
            print("buttonPause or its onTriggerUp event not available")
        }

        // Seek forward button (2 seconds)
        if (this.buttonSeekForward && this.buttonSeekForward.onTriggerUp) {
            this.buttonSeekForward.onTriggerUp.add(() => {
                // Get current time and add 2 seconds
                // Note: This is a simplified implementation
                // You may need to track current time or get it from the video provider
                this.seekRelative(2.0)
            })
        } else {
            print("buttonSeekForward or its onTriggerUp event not available")
        }

        // Seek backwards button (2 seconds)
        if (this.buttonSeekBackwards && this.buttonSeekBackwards.onTriggerUp) {
            this.buttonSeekBackwards.onTriggerUp.add(() => {
                // Get current time and subtract 2 seconds
                this.seekRelative(-2.0)
            })
        } else {
            print("buttonSeekBackwards or its onTriggerUp event not available")
        }
    }

    private setupSliderEvents() {
        if (this.sliderSeek && this.sliderSeek.onValueChange) {
            this.sliderSeek.onValueChange.add((value: number) => {
                if (this.videoPlayback) {
                    const videoDuration = this.videoPlayback.getVideoDuration()
                    if (videoDuration > 0) {
                        const seekTime = value * videoDuration
                        print("Seeking to: " + seekTime + " seconds (slider value: " + value + ")")
                        this.videoPlayback.seekVideo(seekTime)
                    } else {
                        print("Video duration not available yet")
                    }
                }
            })
        } else {
            print("sliderSeek or its onValueChange event not available")
        }
    }

    private seekRelative(seconds: number) {
        if (this.videoPlayback) {
            const currentTime = this.videoPlayback.getCurrentTime()
            const duration = this.videoPlayback.getVideoDuration()
            const newTime = Math.max(0, Math.min(currentTime + seconds, duration))
            print("Seeking from " + currentTime + " to " + newTime)
            this.videoPlayback.seekVideo(newTime)
        }
    }
}