
type RenderCallback = (values: any) => void;
type MetadataCallback = (metadata: { isActive: boolean; hasConflict?: boolean }) => void;

class RenderRegistry {
  private listeners = new Map<string, RenderCallback>();
  private metadataListeners = new Map<string, MetadataCallback>();

  register(id: string, callback: RenderCallback) {
    this.listeners.set(id, callback);
  }

  unregister(id: string) {
    this.listeners.delete(id);
  }

  update(id: string, values: any) {
    const cb = this.listeners.get(id);
    if (cb) cb(values);
  }

  registerMetadata(id: string, callback: MetadataCallback) {
    this.metadataListeners.set(id, callback);
  }

  unregisterMetadata(id: string) {
    this.metadataListeners.delete(id);
  }

  updateMetadata(id: string, metadata: { isActive: boolean; hasConflict?: boolean }) {
    const cb = this.metadataListeners.get(id);
    if (cb) cb(metadata);
  }
}

export const renderRegistry = new RenderRegistry();
