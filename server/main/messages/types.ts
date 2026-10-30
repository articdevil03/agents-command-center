import type { WebSocket } from "ws";

export type MessageHandler = (ws: WebSocket, message: any) => void;
