class HoldRecorder extends AudioWorkletProcessor {
  constructor(){super();this.running=true;this.port.onmessage=e=>{if(e.data==='stop'){this.running=false;this.port.postMessage({done:true});}};}
  process(inputs){const channel=inputs[0]?.[0];if(this.running&&channel)this.port.postMessage({samples:channel.slice()});return this.running;}
}
registerProcessor('hold-recorder',HoldRecorder);
