import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { CoreProvider } from '@classroom/core-client';
import ErrorBoundary from './components/system/ErrorBoundary.jsx';
import AppLayout from './pages/AppLayout.jsx';
import '@classroom/ui-tokens/tokens.css';
import './app.css';

/**
 * Entry point.
 *
 * Everything below the layout is lazy, and the split is deliberate rather than
 * mechanical: the classroom pulls in mediasoup, the builder pulls in dnd-kit,
 * the viewer pulls in hls.js. Somebody who only reads community threads should
 * never download any of the three, which is also why vite.config.ts gives rtc
 * and collab their own chunks.
 *
 * CoreProvider owns the things that are singular per tab — the API client with
 * its refresh and trace ids, the socket, presence, entitlements, notifications.
 * Nothing under it constructs a transport of its own.
 */

const LoginPage = lazy(() => import('./pages/LoginPage.jsx'));
const DashboardPage = lazy(() => import('./pages/DashboardPage.jsx'));
const CoursePage = lazy(() => import('./pages/CoursePage.jsx'));
const CourseBuilderPage = lazy(() => import('./pages/CourseBuilderPage.jsx'));
const ClassroomPage = lazy(() => import('./pages/ClassroomPage.jsx'));
const CommunityPage = lazy(() => import('./pages/CommunityPage.jsx'));
const MessagesPage = lazy(() => import('./pages/MessagesPage.jsx'));
const MediaPage = lazy(() => import('./pages/MediaPage.jsx'));
const SettingsPage = lazy(() => import('./pages/SettingsPage.jsx'));
const NotFoundPage = lazy(() => import('./pages/NotFoundPage.jsx'));

function Loading() {
  return <p className="app app-empty">Loading…</p>;
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary area="app">
      <CoreProvider
        apiUrl={import.meta.env.VITE_API_URL}
        wsUrl={import.meta.env.VITE_WS_URL}
        release={__RELEASE_SHA__}
      >
        <BrowserRouter>
          <Suspense fallback={<Loading />}>
            <Routes>
              <Route path="/login" element={<LoginPage />} />

              <Route element={<AppLayout />}>
                <Route index element={<DashboardPage />} />
                <Route path="courses/:courseId" element={<CoursePage />} />
                <Route path="courses/:courseId/lessons/:lessonId" element={<CoursePage />} />
                <Route path="courses/:courseId/build" element={<CourseBuilderPage />} />
                <Route path="community" element={<CommunityPage />} />
                <Route path="community/spaces/:spaceId" element={<CommunityPage />} />
                <Route path="community/threads/:threadId" element={<CommunityPage />} />
                <Route path="messages" element={<MessagesPage />} />
                <Route path="messages/:conversationId" element={<MessagesPage />} />
                <Route path="media" element={<MediaPage />} />
                <Route path="settings" element={<SettingsPage />} />
                <Route path="settings/:tab" element={<SettingsPage />} />
              </Route>

              {/* The classroom sits outside the layout on purpose: no nav, no
                  chat dock, nothing competing with the lesson for the screen. */}
              <Route path="/rooms/:roomId" element={<ClassroomPage />} />
              <Route path="/lessons/:lessonId/live" element={<ClassroomPage />} />

              <Route path="/app/*" element={<Navigate to="/" replace />} />
              <Route path="*" element={<NotFoundPage />} />
            </Routes>
          </Suspense>
        </BrowserRouter>
      </CoreProvider>
    </ErrorBoundary>
  </StrictMode>,
);