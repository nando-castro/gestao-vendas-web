import { io, Socket } from "socket.io-client";
import { API_URL } from "./api";

type RealtimeHandlers = {
  onInventoryUpdated?: () => void;
  onOrderChanged?: () => void;
};

let socket: Socket | null = null;

export function connectRealtime(handlers: RealtimeHandlers) {
  socket?.disconnect();
  socket = io(API_URL, {
    transports: ["websocket", "polling"],
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 800
  });

  socket.on("inventory:updated", () => handlers.onInventoryUpdated?.());
  socket.on("product:updated", () => handlers.onInventoryUpdated?.());
  socket.on("order:created", () => handlers.onOrderChanged?.());
  socket.on("order:status-updated", () => handlers.onOrderChanged?.());

  return () => {
    socket?.disconnect();
    socket = null;
  };
}

export function debounceRealtime(callback: () => void, delay = 250) {
  let timeout: number | undefined;
  return () => {
    window.clearTimeout(timeout);
    timeout = window.setTimeout(callback, delay);
  };
}
