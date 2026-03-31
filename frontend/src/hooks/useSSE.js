import { useEffect, useRef, useState } from 'react';
import { sseAPI } from '../services/api';

/**
 * Custom hook for Server-Sent Events
 * @param {Object} options - Configuration options
 * @param {Function} options.onMessage - Callback for general messages
 * @param {Function} options.onSyncCompleted - Callback for sync completion
 * @param {Function} options.onConnected - Callback when connected
 * @param {Function} options.onError - Callback for errors
 * @param {boolean} options.enabled - Enable/disable SSE connection
 * @returns {Object} SSE status and controls
 */
export function useSSE(options = {}) {
  const {
    onMessage,
    onSyncCompleted,
    onConnected,
    onError,
    enabled = true,
    reconnectKey = null,
  } = options;

  // Three-state: 'connecting', 'connected', 'disconnected'
  const [connectionStatus, setConnectionStatus] = useState(enabled ? 'connecting' : 'disconnected');
  const [lastEvent, setLastEvent] = useState(null);
  const eventSourceRef = useRef(null);
  const retryTimerRef = useRef(null);
  const retryAttemptRef = useRef(0);
  const unmountedRef = useRef(false);

  useEffect(() => {
    unmountedRef.current = false;

    const clearRetryTimer = () => {
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
    };

    const closeCurrentSource = () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };

    const scheduleReconnect = () => {
      if (!enabled || unmountedRef.current) return;
      clearRetryTimer();

      // Exponential backoff (1s -> 2s -> 4s ... max 15s)
      const delay = Math.min(1000 * (2 ** retryAttemptRef.current), 15000);
      retryAttemptRef.current += 1;
      setConnectionStatus('connecting');

      retryTimerRef.current = setTimeout(() => {
        connect();
      }, delay);
    };

    const connect = () => {
      if (!enabled || unmountedRef.current) return;

      clearRetryTimer();
      closeCurrentSource();
      setConnectionStatus('connecting');

      try {
        const eventSource = sseAPI.getEventSource();
        eventSourceRef.current = eventSource;

        eventSource.onopen = () => {
          retryAttemptRef.current = 0;
          setConnectionStatus('connected');
        };

        eventSource.addEventListener('connected', (event) => {
          // SSE connection established
          retryAttemptRef.current = 0;
          setConnectionStatus('connected');
          if (onConnected) {
            onConnected(JSON.parse(event.data));
          }
        });

        eventSource.addEventListener('sync-completed', (event) => {
          // Sync completed event received
          const data = JSON.parse(event.data);
          setLastEvent({ type: 'sync-completed', data, timestamp: Date.now() });
          if (onSyncCompleted) {
            onSyncCompleted(data);
          }
        });

        eventSource.onmessage = (event) => {
          // SSE message received
          const data = JSON.parse(event.data);
          setLastEvent({ type: 'message', data, timestamp: Date.now() });
          if (onMessage) {
            onMessage(data);
          }
        };

        eventSource.onerror = (error) => {
          console.error('SSE error:', error);

          if (eventSource.readyState === EventSource.CLOSED) {
            // EventSource is fully closed (often after auth/network hiccup).
            // Recreate it ourselves so first-load status can recover automatically.
            scheduleReconnect();
          } else {
            // Browser is retrying handshake automatically.
            setConnectionStatus('connecting');
          }

          if (onError) {
            onError(error);
          }
        };
      } catch (error) {
        console.error('Failed to create SSE connection:', error);
        scheduleReconnect();
        if (onError) {
          onError(error);
        }
      }
    };

    if (!enabled) {
      clearRetryTimer();
      closeCurrentSource();
      setConnectionStatus('disconnected');
      return;
    }

    connect();

    return () => {
      unmountedRef.current = true;
      clearRetryTimer();
      closeCurrentSource();
      setConnectionStatus('disconnected');
    };
  }, [enabled, onMessage, onSyncCompleted, onConnected, onError, reconnectKey]);

  const disconnect = () => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
      setConnectionStatus('disconnected');
    }
  };

  return {
    isConnected: connectionStatus === 'connected',
    connectionStatus,
    lastEvent,
    disconnect,
  };
}
