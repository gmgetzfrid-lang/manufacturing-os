// lib/push/web-push.d.ts
//
// The slice of the `web-push` package (3.6.7, package.json) that
// lib/push/sendPush.ts uses. The package ships no type declarations and
// @types/web-push is not a dependency, so the shapes are declared here —
// only what the sender calls, as the package's src/index.js exports them.

declare module "web-push" {
  export interface PushSubscriptionKeys {
    p256dh: string;
    auth: string;
  }
  export interface PushSubscription {
    endpoint: string;
    keys: PushSubscriptionKeys;
  }
  export interface VapidDetails {
    subject: string;
    publicKey: string;
    privateKey: string;
  }
  export interface RequestOptions {
    vapidDetails?: VapidDetails;
    TTL?: number;
    urgency?: "very-low" | "low" | "normal" | "high";
    topic?: string;
    timeout?: number;
    headers?: Record<string, string>;
    /** web-push uses it for the request when it is an https.Agent */
    agent?: import("node:https").Agent;
  }
  export interface SendResult {
    statusCode: number;
    body: string;
    headers: Record<string, string>;
  }
  export class WebPushError extends Error {
    statusCode: number;
    headers: Record<string, string>;
    body: string;
    endpoint: string;
  }
  export function sendNotification(
    subscription: PushSubscription,
    payload?: string | Buffer | null,
    options?: RequestOptions,
  ): Promise<SendResult>;
  export function setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
  export function generateVAPIDKeys(): { publicKey: string; privateKey: string };
  const webpush: {
    sendNotification: typeof sendNotification;
    setVapidDetails: typeof setVapidDetails;
    generateVAPIDKeys: typeof generateVAPIDKeys;
    WebPushError: typeof WebPushError;
  };
  export default webpush;
}
