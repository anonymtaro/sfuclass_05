import type { NativeStackScreenProps } from '@react-navigation/native-stack';

export type RootStackParamList = {
  Classroom: { roomId: string; lessonId?: string };
  Course: { courseId: string };
  Community: { spaceId: string };
  Chat: { conversationId?: string; channelId?: string };
  Profile: { userId: string };
  Downloads: undefined;
};

export type ScreenProps<T extends keyof RootStackParamList> = NativeStackScreenProps<
  RootStackParamList,
  T
>;