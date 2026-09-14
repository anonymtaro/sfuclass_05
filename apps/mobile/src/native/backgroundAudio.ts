/**
 * apps/mobile/src/native/backgroundAudio.ts
 * Keeps an offline lesson's audio track playing behind the lock screen (F4).
 */
import { Audio, AVPlaybackStatus } from 'expo-av';

let sound: Audio.Sound | null = null;

export async function playOfflineLesson(
  localUri: string,
  onStatusChange?: (status: AVPlaybackStatus) => void,
): Promise<void> {
  await Audio.setAudioModeAsync({
    staysActiveInBackground: true,
    playsInSilentModeIOS: true,
  });

  if (sound) {
    await sound.unloadAsync();
  }
  const { sound: created } = await Audio.Sound.createAsync(
    { uri: localUri },
    { shouldPlay: true },
    onStatusChange,
  );
  sound = created;
}

export async function stopOfflinePlayback(): Promise<void> {
  if (!sound) return;
  await sound.stopAsync();
  await sound.unloadAsync();
  sound = null;
}