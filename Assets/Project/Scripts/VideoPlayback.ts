@component
export class VideoPlayback extends BaseScriptComponent {
    @input
    movie: Image;

    getVideoDuration(): number {
        var provider = this.movie.mainPass.baseTex.control as VideoTextureProvider;
        if (provider && provider.duration !== undefined) {
            return provider.duration;
        }
        return 0;
    }

    getCurrentTime(): number {
        var provider = this.movie.mainPass.baseTex.control as VideoTextureProvider;
        if (provider && provider.currentTime !== undefined) {
            return provider.currentTime;
        }
        return 0;
    }

    seekVideo(seekTime: number) {
        var provider = this.movie.mainPass.baseTex.control as VideoTextureProvider;
        if (provider && provider.seek) {
            provider.seek(seekTime);
            print("Video seeked to " + seekTime + " seconds");
        } else {
            print("Video control not available or seek method is not supported");
        }
    }

    playVideo(loops: number) {
        var provider = this.movie.mainPass.baseTex.control as VideoTextureProvider;
        if (provider && provider.play) {
            provider.play(loops);
            print("Video is playing " + loops + " times");
        } else {
            print("Video control not available or play method is not supported");
        }
    }

    pauseVideo() {
        var provider = this.movie.mainPass.baseTex.control as VideoTextureProvider;
        if (provider && provider.pause) {
            provider.pause();
            print("Video paused");
        } else {
            print("Video control not available or pause method is not supported");
        }
    }

    resumeVideo() {
        var provider = this.movie.mainPass.baseTex.control as VideoTextureProvider;
        if (provider && provider.resume) {
            provider.resume();
            print("Video resumed");
        } else {
            print("Video control not available or resume method is not supported");
        }
    }

    onAwake() {
        // Play video in infinite loop for continuous frame capture
        this.playVideo(-1);  // -1 = infinite loops
        print("Video playing continuously for Ramblr frame capture");
    }
}
