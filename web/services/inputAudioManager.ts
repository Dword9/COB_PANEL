
import { splitThreeBands, logBands, SPECTRUM_BANDS } from '../utils/audioBands';

type InputRuntime = {
  audioCtx: AudioContext | null;
  analyser: AnalyserNode | null;
  sourceNode: AudioNode | null;
  stream: MediaStream | null;
  audioElement: HTMLAudioElement | null;
  rafId: number | null;
  isActive: boolean;
  /** Generation counter: защита от гонки конкурентных setupLive/destroy */
  setupToken: number;
};

class InputAudioManager {
  private runtimes: Record<string, InputRuntime> = {};
  private levelCallbacks: Record<string, (levels: { low: number, mid: number, high: number }) => void> = {};
  private bandCallbacks: Record<string, (bands: number[]) => void> = {};
  // Фон-устойчивый тикер: rAF на скрытой вкладке замирает, Worker — нет
  private dataArray: Uint8Array | null = null;
  private tickWorker: Worker | null = null;
  private activeNodes = new Set<string>();

  getOrCreate(nodeId: string): InputRuntime {
    if (!this.runtimes[nodeId]) {
      this.runtimes[nodeId] = {
        audioCtx: null,
        analyser: null,
        sourceNode: null,
        stream: null,
        audioElement: null,
        rafId: null,
        isActive: false,
        setupToken: 0,
      };
    }
    return this.runtimes[nodeId];
  }

  onLevels(nodeId: string, cb: (levels: { low: number, mid: number, high: number }) => void) {
    this.levelCallbacks[nodeId] = cb;
  }

  offLevels(nodeId: string) {
    delete this.levelCallbacks[nodeId];
  }

  onBands(nodeId: string, cb: (bands: number[]) => void) {
    this.bandCallbacks[nodeId] = cb;
  }

  offBands(nodeId: string) {
    delete this.bandCallbacks[nodeId];
  }

  initAudio(nodeId: string) {
    const rt = this.getOrCreate(nodeId);
    if (!rt.audioCtx) {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      rt.audioCtx = new AudioCtx();
      rt.analyser = rt.audioCtx.createAnalyser();
      // fftSize=2048 → 23 Гц/бин при 48 кГц: бас (20-250 Гц) = ~10 бинов.
      // Раньше было 256 → 187 Гц/бин: весь бас умещался в ОДИН бин и
      // полосы делились линейно по бинам (LOW получался 0-7.5 кГц, грабля
      // «непонятные частоты»). Границы полос — в audioBands.ts.
      rt.analyser.fftSize = 2048;
      // Огибающую (attack/decay) лепит DSP-нода в графе, здесь нужна живая
      // реакция сырого сигнала, а не дефолтные 0.8 ватного сглаживания.
      rt.analyser.smoothingTimeConstant = 0.5;
    }
    return { ctx: rt.audioCtx, analyser: rt.analyser! };
  }

  async setupLive(nodeId: string, deviceId: string): Promise<boolean> {
    const { ctx, analyser } = this.initAudio(nodeId);
    const rt = this.runtimes[nodeId];
    const token = ++rt.setupToken;

    this.stopSource(nodeId);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: { deviceId: deviceId === 'default' ? undefined : { exact: deviceId } } 
      });
      if (token !== rt.setupToken) {
        // Пока ждали getUserMedia, пришёл новый setup/destroy — этот стрим не нужен
        stream.getTracks().forEach(t => t.stop());
        return false;
      }
      rt.stream = stream;
      const src = ctx.createMediaStreamSource(stream);
      src.connect(analyser);
      rt.sourceNode = src;
      this.startLoop(nodeId);
      return true;
    } catch (e) {
      console.error(e);
      return false;
    }
  }

  setupFile(nodeId: string, audioElement: HTMLAudioElement) {
    const { ctx, analyser } = this.initAudio(nodeId);
    const rt = this.getOrCreate(nodeId);
    rt.setupToken++; // отменяет незавершённый setupLive
    
    this.stopSource(nodeId);
    rt.audioElement = audioElement;

    try {
      // Need to avoid creating multiple MediaElementSources for same element
      const src = (audioElement as any)._node || ctx.createMediaElementSource(audioElement);
      (audioElement as any)._node = src;
      src.disconnect(); // Clear old connections
      src.connect(analyser);
      src.connect(ctx.destination); // Connect file source to speakers
      rt.sourceNode = src;
      this.startLoop(nodeId);
    } catch (e) {
      console.error(e);
    }
  }

  stopSource(nodeId: string) {
    const rt = this.runtimes[nodeId];
    if (!rt) return;
    if (rt.sourceNode) {
        try { rt.sourceNode.disconnect(); } catch(e) {}
        rt.sourceNode = null;
    }
    if (rt.stream) { 
        rt.stream.getTracks().forEach(t => t.stop()); 
        rt.stream = null; 
    }
  }

  stopLoop(nodeId: string) {
    const rt = this.runtimes[nodeId];
    if (!rt) return;
    rt.isActive = false;
    this.activeNodes.delete(nodeId);
    if (this.activeNodes.size === 0 && this.tickWorker) {
        this.tickWorker.postMessage('stop');
    }
  }

  startLoop(nodeId: string) {
    const rt = this.getOrCreate(nodeId);
    if (rt.isActive) return;
    rt.isActive = true;
    this.activeNodes.add(nodeId);
    this.ensureWorker();
  }

  private ensureWorker() {
    if (!this.tickWorker) {
      const blob = new Blob([`
        let timer = null;
        self.onmessage = function(e) {
          if (e.data === 'start') { if (timer) clearInterval(timer); timer = setInterval(() => self.postMessage('tick'), 16); }
          else if (e.data === 'stop') { if (timer) { clearInterval(timer); timer = null; } }
        };
      `], { type: 'application/javascript' });
      this.tickWorker = new Worker(URL.createObjectURL(blob));
      this.tickWorker.onmessage = () => this.tickAll();
    }
    this.tickWorker.postMessage('start');
  }

  private tickAll() {
    this.activeNodes.forEach(id => this.sample(id));
  }

  private sample(nodeId: string) {
    const rt = this.runtimes[nodeId];
    if (!rt || !rt.isActive || !rt.analyser || !rt.audioCtx) return;

    // Буфер переиспользуется между тиками, чтобы не дёргать GC на 60 fps
    if (!this.dataArray || this.dataArray.length !== rt.analyser.frequencyBinCount) {
      this.dataArray = new Uint8Array(rt.analyser.frequencyBinCount);
    }
    rt.analyser.getByteFrequencyData(this.dataArray);

    const sampleRate = rt.audioCtx.sampleRate;
    // Спектр на ноде — логарифмические полосы 20 Гц..16 кГц (басу ~10 столбиков,
    // а не 1-2, как при линейном делении)
    this.bandCallbacks[nodeId]?.(logBands(this.dataArray, sampleRate, SPECTRUM_BANDS));
    // LOW 20-250 / MID 250-4000 / HIGH 4000-16000 Гц — см. audioBands.ts
    this.levelCallbacks[nodeId]?.(splitThreeBands(this.dataArray, sampleRate));
  }

  destroy(nodeId: string) {
    const rt = this.runtimes[nodeId];
    if (rt) rt.setupToken++; // отменяет незавершённый setupLive
    this.stopLoop(nodeId);
    this.stopSource(nodeId);
    if (rt?.audioCtx && rt.audioCtx.state !== 'closed') {
        rt.audioCtx.close().catch(() => {});
    }
    delete this.runtimes[nodeId];
    delete this.levelCallbacks[nodeId];
    delete this.bandCallbacks[nodeId];
  }
}

export const inputAudioManager = new InputAudioManager();
