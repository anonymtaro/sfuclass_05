/**
 * Public surface of the client core  (F5)
 *
 * Everything here is platform-agnostic. The browser and React Native
 * implementations of DeviceAdapter and ScreenShareAdapter are selected by the
 * consuming app and injected, which is what lets this package stay free of both
 * lib.dom and react-native-webrtc.
 *
 * Note on what is *not* re-exported: nothing pulls in mediasoup-client at
 * import time. SfuClient takes its Device constructor by injection precisely so
 * that importing this barrel — which every page does — never drags the media
 * stack into the main bundle.
 */

// --- context (F5) ---------------------------------------------------------
export * from './CoreProvider.js';

// --- transport ------------------------------------------------------------
export * from './http/httpClient.js';
export * from './socket/socketClient.js';
export * from './socket/outboxQueue.js';

// --- realtime media (F1) --------------------------------------------------
export * from './rtc/SfuClient.js';
export * from './rtc/DeviceAdapter.js';
export * from './rtc/ScreenShareAdapter.js';
export * from './rtc/nodeResolver.js';

// --- api clients ----------------------------------------------------------
export * from './api/courseApi.js';
export * from './api/communityApi.js';
export * from './api/mediaApi.js';
export * from './api/chatApi.js';
export * from './api/profileApi.js';
export * from './api/progressApi.js';
export * from './api/billingApi.js';

// --- state ----------------------------------------------------------------
export * from './state/useClassroom.js';
export * from './state/useScreenShare.js';
export * from './state/useCourse.js';
export * from './state/useCommunity.js';
export * from './state/useChat.js';
export * from './state/usePresence.js';
export * from './state/useUpload.js';
export * from './state/useBilling.js';

// --- offline (F5) ---------------------------------------------------------
export * from './offline/syncQueue.js';
export * from './offline/assetCache.js';