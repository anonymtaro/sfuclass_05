/**
 * apps/mobile/src/native/pushHandler.ts
 * Registers the device with identity/DeviceRegistry.js and routes incoming
 * pushes to the right screen (F2, F6).
 */
import * as Notifications from 'expo-notifications';
import { apiRequest } from '@classroom/core-client';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: false,
    shouldSetBadge: true,
  }),
});

export async function registerForPushNotifications(): Promise<void> {
  const { status } = await Notifications.requestPermissionsAsync();
  if (status !== 'granted') return;

  const token = (await Notifications.getExpoPushTokenAsync()).data;
  await apiRequest('/auth/devices/push-token', {
    method: 'POST',
    body: { token, platform: 'expo' },
  });
}

export type PushNavigationTarget =
  | { screen: 'Chat'; conversationId: string }
  | { screen: 'Community'; spaceId: string; threadId?: string };

export function parsePushTarget(data: Record<string, unknown>): PushNavigationTarget | null {
  if (data.type === 'chat.message' && typeof data.conversationId === 'string') {
    return { screen: 'Chat', conversationId: data.conversationId };
  }
  if (data.type === 'community.post' && typeof data.spaceId === 'string') {
    return {
      screen: 'Community',
      spaceId: data.spaceId,
      threadId: typeof data.threadId === 'string' ? data.threadId : undefined,
    };
  }
  return null;
}