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
  } = options;

  // Three-state: 'connecting', 'connected', 'disconnected'
  const [connectionStatus, setConnectionStatus] = useState(enabled ? 'connecting' : 'disconnected');
  const [lastEvent, setLastEvent] = useState(null);
  const eventSourceRef = useRef(null);

  useEffect(() => {
    if (!enabled) {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      setConnectionStatus('disconnected');
      return;
    }

    setConnectionStatus('connecting');

    try {
      const eventSource = sseAPI.getEventSource();
      eventSourceRef.current = eventSource;

      eventSource.onopen = () => {
        setConnectionStatus('connected');
      };

      eventSource.addEventListener('connected', (event) => {
        console.log('SSE connected:', event.data);
        setConnectionStatus('connected');
        if (onConnected) {
          onConnected(JSON.parse(event.data));
        }
      });

      eventSource.addEventListener('sync-completed', (event) => {
        console.log('Sync completed:', event.data);
        const data = JSON.parse(event.data);
        setLastEvent({ type: 'sync-completed', data, timestamp: Date.now() });
        if (onSyncCompleted) {
          onSyncCompleted(data);
        }
      });

      eventSource.onmessage = (event) => {
        console.log('SSE message:', event.data);
        const data = JSON.parse(event.data);
        setLastEvent({ type: 'message', data, timestamp: Date.now() });
        if (onMessage) {
          onMessage(data);
        }
      };

      eventSource.onerror = (error) => {
        console.error('SSE error:', error);
        if (eventSource.readyState === EventSource.CLOSED) {
          setConnectionStatus('disconnected');
        } else {
          // CONNECTING state — browser is retrying automatically
          setConnectionStatus('connecting');
        }
        if (onError) {
          onError(error);
        }
      };

      return () => {
        console.log('Closing SSE connection');
        eventSource.close();
        setConnectionStatus('disconnected');
      };
    } catch (error) {
      console.error('Failed to create SSE connection:', error);
      setConnectionStatus('disconnected');
      if (onError) {
        onError(error);
      }
    }
  }, [enabled, onMessage, onSyncCompleted, onConnected, onError]);

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
