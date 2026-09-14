import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StatusBar, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { NavigationContainer, type LinkingOptions, type Theme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { CoreProvider, useAuth, useSocketStatus } from '@classroom/core-client';
import { colors } from '@classroom/ui-tokens';

import ClassroomScreen from './src/screens/ClassroomScreen';
import CourseScreen from './src/screens/CourseScreen';
import CommunityScreen from './src/screens/CommunityScreen';
import ChatScreen from './src/screens/ChatScreen';
import ProfileScreen from './src/screens/ProfileScreen';
import DownloadsScreen from './src/screens/DownloadsScreen';
import LoginScreen from './src/screens/LoginScreen';

import { registerPushToken, usePushNavigation } from './src/native/pushHandler';
import { config } from './src/config';

/**
 * Root of the Expo app.
 *
 * The shape mirrors apps/web on purpose: one provider owning the API client,
 * socket, presence and entitlements; everything below it is presentation. The
 * two apps share packages/contracts and packages/core-client, so a change to a
 * payload breaks both at compile time rather than in one of them at runtime.
 *
 * Three things are mobile-only and all of them live here rather than in a
 * screen:
 *   deep links      a push about a reply has to open that reply, cold start
 *                   included, which only the container can do
 *   token handoff   the push token is registered once the session exists, not
 *                   once the app launches — an anonymous token belongs to nobody
 *   the classroom   it is a modal stack screen outside the tabs, for the same
 *                   reason the web route sits outside AppLayout: a lesson gets
 *                   the whole screen
 */

const Tabs = createBottomTabNavigator();
const Stack = createNativeStackNavigator();

const theme: Theme = {
  dark: true,
  colors: {
    primary: colors.accent,
    background: colors.background,
    card: colors.surfaceRaised,
    text: colors.text,
    border: colors.border,
    notification: colors.accent,
  },
};

/** Paths match apps/web so one shared link opens either client. */
const linking: LinkingOptions<ReactNavigation.RootParamList> = {
  prefixes: ['classroom://', `https://${config.appDomain}`],
  config: {
    screens: {
      Main: {
        screens: {
          Courses: 'courses/:courseId?',
          Community: {
            path: 'community',
            screens: { Space: 'spaces/:spaceId', Thread: 'threads/:threadId' },
          },
          Chat: 'messages/:conversationId?',
          Downloads: 'downloads',
          Profile: 'profile/:userId?',
        },
      },
      Classroom: 'rooms/:roomId',
    },
  },
};

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" />
      <CoreProvider apiUrl={config.apiUrl} wsUrl={config.wsUrl} release={config.release}>
        <Root />
      </CoreProvider>
    </SafeAreaProvider>
  );
}

function Root() {
  const { status, user } = useAuth();
  const navigationRef = useRef(null);
  const [navReady, setNavReady] = useState(false);

  // The token is a fact about this signed-in person on this device, so it is
  // registered after authentication and removed on sign-out. DeviceRegistry
  // keeps one row per device, not per launch.
  useEffect(() => {
    if (status !== 'authenticated') return;
    registerPushToken().catch(() => {
      /* a device without notification permission is a normal device */
    });
  }, [status, user?.id]);

  usePushNavigation(navigationRef, navReady);

  const onReady = useCallback(() => setNavReady(true), []);

  if (status === 'loading') {
    return (
      <View style={styles.centre}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <NavigationContainer ref={navigationRef} theme={theme} linking={linking} onReady={onReady}>
      <ConnectionStrip />

      {status !== 'authenticated' ? (
        <Stack.Navigator screenOptions={{ headerShown: false }}>
          <Stack.Screen name="Login" component={LoginScreen} />
        </Stack.Navigator>
      ) : (
        <Stack.Navigator>
          <Stack.Screen name="Main" component={MainTabs} options={{ headerShown: false }} />

          {/* Full screen, no tabs, gesture off: leaving a lesson by swiping back
              by accident is worse than one extra tap. */}
          <Stack.Screen
            name="Classroom"
            component={ClassroomScreen}
            options={{
              presentation: 'fullScreenModal',
              headerShown: false,
              gestureEnabled: false,
              orientation: 'all',
            }}
          />
        </Stack.Navigator>
      )}
    </NavigationContainer>
  );
}

function MainTabs() {
  return (
    <Tabs.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: colors.surfaceRaised },
        headerTintColor: colors.text,
        tabBarStyle: { backgroundColor: colors.surfaceRaised, borderTopColor: colors.border },
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.textMuted,
      }}
    >
      {/* No builder tab. Authoring is a desktop job — the mobile app consumes
          courses, it does not edit them (F5). */}
      <Tabs.Screen name="Courses" component={CourseScreen} />
      <Tabs.Screen name="Community" component={CommunityScreen} />
      <Tabs.Screen name="Chat" component={ChatScreen} options={{ title: 'Messages' }} />
      <Tabs.Screen name="Downloads" component={DownloadsScreen} />
      <Tabs.Screen name="Profile" component={ProfileScreen} />
    </Tabs.Navigator>
  );
}

/**
 * The mobile counterpart of ConnectionBanner: same three states, one line, and
 * the same 1.5 s of silence before it says anything — a phone changes network
 * constantly and a strip that blinks at every handover is a strip people stop
 * reading.
 */
function ConnectionStrip() {
  const status = useSocketStatus();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (status === 'connected') {
      setVisible(false);
      return undefined;
    }
    const id = setTimeout(() => setVisible(true), 1500);
    return () => clearTimeout(id);
  }, [status]);

  if (!visible) return null;

  return (
    <View style={styles.strip}>
      <Text style={styles.stripText}>
        {status === 'connecting'
          ? 'Reconnecting — live updates are paused.'
          : 'Offline. Anything you write is kept and sent later.'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  centre: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
  },
  strip: {
    paddingVertical: 6,
    paddingHorizontal: 14,
    backgroundColor: colors.warning,
  },
  stripText: {
    color: '#06101f',
    fontSize: 12,
  },
});