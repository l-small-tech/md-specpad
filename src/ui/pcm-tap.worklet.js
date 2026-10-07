/*
 * The audio-thread half of pcm-capture.ts: posts every input frame (128
 * samples) to the main thread, verbatim.
 *
 * Plain JavaScript, loaded by `audioWorklet.addModule` from its own built
 * file (imported with `?url&no-inline`) — so it runs in an
 * AudioWorkletGlobalScope, untouched by the bundler, and the release CSP's
 * `'self'` covers it. A Blob or data: URL would be refused there.
 */
/* global AudioWorkletProcessor, registerProcessor */

class PcmTap extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length > 0) {
      this.port.postMessage(channel.slice(0));
    }
    return true;
  }
}

registerProcessor('pcm-tap', PcmTap);
