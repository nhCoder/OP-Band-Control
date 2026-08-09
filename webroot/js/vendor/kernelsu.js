/*
 * Adapted from KernelSU's official WebUI JavaScript library v3.0.2.
 * Copyright KernelSU contributors. Licensed under Apache-2.0.
 * Source: https://github.com/tiann/KernelSU/tree/main/js
 */

let callbackCounter = 0;

function getUniqueCallbackName(prefix) {
  return `${prefix}_callback_${Date.now()}_${callbackCounter++}`;
}

export function hasKernelSUBridge() {
  return Boolean(window.ksu && typeof window.ksu.spawn === 'function');
}

function createEmitter() {
  const listeners = new Map();
  return {
    on(event, listener) {
      const existing = listeners.get(event) || [];
      existing.push(listener);
      listeners.set(event, existing);
      return this;
    },
    emit(event, ...args) {
      (listeners.get(event) || []).forEach((listener) => listener(...args));
    },
  };
}

export function spawn(command, args = [], options = {}) {
  if (!hasKernelSUBridge()) {
    throw new Error('KernelSU WebUI bridge is unavailable');
  }

  const child = createEmitter();
  child.stdin = createEmitter();
  child.stdout = createEmitter();
  child.stderr = createEmitter();

  const callbackName = getUniqueCallbackName('spawn');
  window[callbackName] = child;

  const cleanup = () => {
    delete window[callbackName];
  };
  child.on('exit', cleanup);
  child.on('error', cleanup);

  try {
    window.ksu.spawn(command, JSON.stringify(args), JSON.stringify(options), callbackName);
  } catch (error) {
    child.emit('error', error);
  }

  return child;
}

export function enableEdgeToEdge(enable) {
  try {
    window.ksu?.enableEdgeToEdge?.(Boolean(enable));
  } catch (_) {
    // Older managers do not expose this optional method.
  }
}

export function nativeToast(message) {
  try {
    window.ksu?.toast?.(String(message));
  } catch (_) {
    // The in-page toast remains available as a fallback.
  }
}
