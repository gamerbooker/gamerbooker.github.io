export class EventEmitter {
  constructor() {
    this.events = {};
  }

  addEventListener(event, listener, options = {}) {
    if (!this.events[event]) this.events[event] = [];
    this.events[event].push({ callback: listener, once: options.once || false });
  }

  removeEventListener(event, listener) {
    if (!this.events[event]) return;
    this.events[event] = this.events[event].filter((wrapped) => wrapped.callback !== listener);
  }

  dispatchEvent(event) {
    if (!this.events[event.type]) return;
    this.events[event.type] = this.events[event.type].filter((wrapped) => {
      wrapped.callback.call(this, event);
      return !wrapped.once;
    });
  }

  emit(eventName, data) {
    this.dispatchEvent(new LocalCustomEvent(eventName, { detail: data }));
  }
}

export class LocalCustomEvent {
  constructor(type, options = {}) {
    this.type = type;
    this.detail = options.detail;
    this.target = null;
    this.currentTarget = null;
    this.defaultPrevented = false;
    this.bubbles = options.bubbles || false;
    this.cancelable = options.cancelable || false;
  }

  preventDefault() {
    if (this.cancelable) this.defaultPrevented = true;
  }
}

export { LocalCustomEvent as CustomEvent };
