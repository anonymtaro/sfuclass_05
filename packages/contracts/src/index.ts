/**
 * packages/contracts/src/index.ts
 * Single source of truth for shapes shared between server, web and mobile.
 * Mirrors: course.schema.ts, community.schema.ts, chat.schema.ts,
 * profile.schema.ts, media.schema.ts (F2, F3, F4, F6).
 */

// ---- identity / profile (F6) ----
export type UserRole = 'owner' | 'teacher' | 'learner';

export interface Profile {
  userId: string;
  displayName: string;
  avatarUrl?: string;
  bio?: string;
  role: UserRole;
  dmPolicy: 'anyone' | 'shared-context' | 'nobody';
}

// ---- messaging (F6) ----
export type ChannelScope = 'public' | 'space' | 'course';

export interface Channel {
  id: string;
  scope: ChannelScope;
  title: string;
  contextId?: string; // spaceId or courseId when scope !== 'public'
}

export interface Conversation {
  id: string;
  participantIds: string[];
  isGroup: boolean;
  lastMessagePreview?: string;
  lastMessageAt?: string;
  unreadCount: number;
}

export interface MessageAttachment {
  id: string;
  assetId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  previewUrl?: string; // signed CloudFront URL, short TTL
  downloadUrl?: string;
}

export interface Message {
  id: string;
  conversationId?: string; // set for DMs/groups
  channelId?: string; // set for public/space/course channels
  senderId: string;
  body: string;
  attachments: MessageAttachment[];
  createdAt: string;
  editedAt?: string;
  deletedAt?: string;
  dedupeKey: string; // client-generated, for at-least-once delivery
}

export type TypingEvent = { conversationOrChannelId: string; userId: string };

// ---- courses (F3) ----
export type LessonType = 'live' | 'video' | 'doc' | 'quiz' | 'task';

export interface Lesson {
  id: string;
  moduleId: string;
  title: string;
  type: LessonType;
  liveRoomId?: string; // set when type === 'live', links to classroom Room (F1,F3)
  videoAssetId?: string;
  durationSeconds?: number;
  completed: boolean;
}

export interface CourseModule {
  id: string;
  courseId: string;
  title: string;
  lessons: Lesson[];
}

export interface Course {
  id: string;
  title: string;
  description: string;
  coverImageUrl?: string;
  modules: CourseModule[];
  progressPercent: number;
  certificateUrl?: string;
}

// ---- community (F2) ----
export interface Space {
  id: string;
  title: string;
  courseId?: string;
}

export interface Post {
  id: string;
  threadId: string;
  authorId: string;
  body: string;
  createdAt: string;
  reactionCount: number;
}

export interface Thread {
  id: string;
  spaceId: string;
  title: string;
  postCount: number;
  lastActivityAt: string;
}

// ---- media (F4) ----
export type AssetStatus = 'uploading' | 'processing' | 'ready' | 'failed';

export interface Asset {
  id: string;
  status: AssetStatus;
  kind: 'image' | 'video' | 'document' | 'other';
  fileName: string;
  sizeBytes: number;
  hlsUrl?: string;
  captionsUrl?: string;
  downloadUrl?: string;
}

export interface DownloadedLesson {
  lessonId: string;
  courseId: string;
  title: string;
  localUri: string;
  sizeBytes: number;
  downloadedAt: string;
}

// ---- presence (shared F2/F6) ----
export type PresenceStatus = 'online' | 'away' | 'in-class' | 'offline';
export interface PresenceEntry {
  userId: string;
  status: PresenceStatus;
  updatedAt: string;
}

// ---- classroom (F1) ----
export interface Peer {
  id: string;
  displayName: string;
  role: UserRole;
  isSpeaking: boolean;
  hasCam: boolean;
  hasMic: boolean;
  isScreenSharing: boolean;
}

export interface ClassroomState {
  roomId: string;
  lessonId?: string;
  peers: Peer[];
  localPeerId: string;
  activeScreenShareePeerId?: string;
  connectionState: 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
}