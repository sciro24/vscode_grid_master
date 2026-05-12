class UiStore {
  // Start as loading — the host will send LOADING:false once data arrives.
  // This prevents the "empty state" flash before the first message.
  loading = $state(true);
  loadingMessage = $state('Opening file…');
  loadingProgress = $state<number | undefined>(undefined);
  error = $state<string | null>(null);
  saved = $state(true);
  isDirty = $state(false);
  largeFileWarning = $state<{ fileSizeMb: number } | null>(null);
  streamProgress = $state<number | undefined>(undefined);

  setLoading(active: boolean, message?: string, progress?: number): void {
    this.loading = active;
    this.loadingMessage = message ?? '';
    this.loadingProgress = progress;
    if (!active) {
      this.error = null;
      this.streamProgress = undefined;
    }
  }

  setLargeFileWarning(info: { fileSizeMb: number } | null): void {
    this.largeFileWarning = info;
  }

  setStreamProgress(pct: number): void {
    this.streamProgress = pct;
  }

  setError(message: string): void {
    this.error = message;
    this.loading = false;
  }

  setSaved(success: boolean): void {
    this.saved = success;
    if (success) this.isDirty = false;
  }

  markDirty(): void {
    this.isDirty = true;
    this.saved = false;
  }
}

export const uiStore = new UiStore();
