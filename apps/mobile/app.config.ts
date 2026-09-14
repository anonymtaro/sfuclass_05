import type { ConfigContext, ExpoConfig } from 'expo/config';

/**
 * apps/mobile — Expo config.
 *
 * Read this as the list of native things the product actually needs, and why:
 *
 *   react-native-webrtc      F1. mediasoup-client runs unchanged on top of it;
 *                            rtcAdapter.ts implements the same DeviceAdapter
 *                            interface the web app uses, so packages/core-client
 *                            has no idea which platform it is on.
 *   ReplayKit / MediaProjection
 *                            F1 screen sharing. iOS needs a broadcast upload
 *                            extension, which is why there is an app group and
 *                            an extension bundle id below.
 *   background audio         F4. A learner who locks the phone during a lesson
 *                            recording keeps hearing it.
 *   notifications            F2/F6. One worker fans out to APNs and FCM; the
 *                            device token is registered by native/pushHandler.ts.
 *   document picker / media library
 *                            F6 chat attachments and F4 submissions.
 *
 * Everything environment-specific comes from the EAS build profile, never from
 * a literal here — same rule as the server's zod schema.
 */

const VARIANT = process.env.APP_VARIANT ?? 'production';
const IS_DEV = VARIANT === 'development';
const IS_PREVIEW = VARIANT === 'preview';

const BUNDLE = IS_DEV
  ? 'com.classroom.app.dev'
  : IS_PREVIEW
    ? 'com.classroom.app.preview'
    : 'com.classroom.app';

const NAME = IS_DEV ? 'Classroom (dev)' : IS_PREVIEW ? 'Classroom (preview)' : 'Classroom';

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: NAME,
  slug: 'classroom',
  scheme: 'classroom',
  version: '1.0.0',
  orientation: 'default',
  userInterfaceStyle: 'automatic',
  newArchEnabled: true,
  assetBundlePatterns: ['**/*'],

  icon: './assets/icon.png',
  splash: {
    image: './assets/splash.png',
    resizeMode: 'contain',
    backgroundColor: '#0b0e13',
  },

  // Deep links: a push about a reply or a lesson opens the thing itself, not the
  // home screen. The paths mirror apps/web's routes so one link works anywhere.
  ios: {
    bundleIdentifier: BUNDLE,
    supportsTablet: true,
    associatedDomains: [`applinks:${process.env.APP_DOMAIN ?? 'app.example.com'}`],
    entitlements: {
      'com.apple.security.application-groups': [`group.${BUNDLE}`],
    },
    infoPlist: {
      NSCameraUsageDescription:
        'Classroom uses the camera so you can be seen in a live lesson.',
      NSMicrophoneUsageDescription:
        'Classroom uses the microphone so you can speak in a live lesson.',
      NSPhotoLibraryUsageDescription:
        'Classroom needs access to your photos so you can attach them to a message or an assignment.',
      // Audio keeps a recording playing with the screen locked; voip is not
      // requested — there are no background calls, only foreground lessons.
      UIBackgroundModes: ['audio', 'remote-notification'],
      ITSAppUsesNonExemptEncryption: false,
    },
  },

  android: {
    package: BUNDLE,
    adaptiveIcon: {
      foregroundImage: './assets/adaptive-icon.png',
      backgroundColor: '#0b0e13',
    },
    permissions: [
      'CAMERA',
      'RECORD_AUDIO',
      'MODIFY_AUDIO_SETTINGS',
      'INTERNET',
      'POST_NOTIFICATIONS',
      'FOREGROUND_SERVICE',
      'FOREGROUND_SERVICE_MEDIA_PROJECTION',
      'READ_MEDIA_IMAGES',
      'READ_MEDIA_VIDEO',
    ],
    intentFilters: [
      {
        action: 'VIEW',
        autoVerify: true,
        data: [{ scheme: 'https', host: process.env.APP_DOMAIN ?? 'app.example.com' }],
        category: ['BROWSABLE', 'DEFAULT'],
      },
    ],
  },

  plugins: [
    [
      'expo-build-properties',
      {
        ios: { deploymentTarget: '15.1', useFrameworks: 'static' },
        android: { minSdkVersion: 24, compileSdkVersion: 35, targetSdkVersion: 35 },
      },
    ],
    '@config-plugins/react-native-webrtc',
    [
      'expo-notifications',
      { icon: './assets/notification-icon.png', color: '#4c8dff' },
    ],
    'expo-secure-store',
    'expo-document-picker',
    ['expo-av', { microphonePermission: false }],
    // Local plugin: adds the iOS broadcast upload extension used by
    // native/screenShareAdapter.ts. Android needs no extension — MediaProjection
    // is a permission, not a separate target.
    ['./plugins/withBroadcastExtension', { appGroup: `group.${BUNDLE}`, bundleId: `${BUNDLE}.broadcast` }],
  ],

  // Read by src/config.ts and passed down to CoreProvider, so nothing in the app
  // reaches into Constants directly.
  extra: {
    apiUrl: process.env.API_URL,
    wsUrl: process.env.WS_URL,
    cdnUrl: process.env.CDN_URL,
    variant: VARIANT,
    release: process.env.RELEASE_SHA ?? 'dev',
    eas: { projectId: process.env.EAS_PROJECT_ID },
  },

  updates: {
    url: process.env.EAS_UPDATE_URL,
    // A contract change ships with a build, not an OTA update — the API keeps
    // the previous contract version alive for one release cycle, and an OTA
    // that skipped a native build would land outside that window.
    fallbackToCacheTimeout: 0,
  },

  runtimeVersion: { policy: 'appVersion' },
});