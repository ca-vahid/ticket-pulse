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

  const [isConnected, setIsConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState(null);
  const eventSourceRef = useRef(null);

  useEffect(() => {
    if (!enabled) {
      // Clean up existing connection if disabled
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
        setIsConnected(false);
      }
      return;
    }

    // Create EventSource connection
    try {
      const eventSource = sseAPI.getEventSource();
      eventSourceRef.current = eventSource;

      // Connection established
      eventSource.addEventListener('connected', (event) => {
        console.log('SSE connected:', event.data);
        setIsConnected(true);
        if (onConnected) {
          onConnected(JSON.parse(event.data));
        }
      });

      // Sync completed event
      eventSource.addEventListener('sync-completed', (event) => {
        console.log('Sync completed:', event.data);
        const data = JSON.parse(event.data);
        setLastEvent({ type: 'sync-completed', data, timestamp: Date.now() });
        if (onSyncCompleted) {
          onSyncCompleted(data);
        }
      });

      // Generic message event
      eventSource.onmessage = (event) => {
        console.log('SSE message:', event.data);
        const data = JSON.parse(event.data);
        setLastEvent({ type: 'message', data, timestamp: Date.now() });
        if (onMessage) {
          onMessage(data);
        }
      };

      // Error handling
      eventSource.onerror = (error) => {
        console.error('SSE error:', error);
        setIsConnected(false);
        if (onError) {
          onError(error);
        }

        // EventSource will automatically try to reconnect
        // But we can detect if it's permanently failed
        if (eventSource.readyState === EventSource.CLOSED) {
          console.log('SSE connection closed');
        }
      };

      // Cleanup on unmount
      return () => {
        console.log('Closing SSE connection');
        eventSource.close();
        setIsConnected(false);
      };
    } catch (error) {
      console.error('Failed to create SSE connection:', error);
      if (onError) {
        onError(error);
      }
    }
  }, [enabled, onMessage, onSyncCompleted, onConnected, onError]);

  /**
   * Manually close the connection
   */
  const disconnect = () => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
      setIsConnected(false);
    }
  };

  return {
    isConnected,
    lastEvent,
    disconnect,
  };
}
