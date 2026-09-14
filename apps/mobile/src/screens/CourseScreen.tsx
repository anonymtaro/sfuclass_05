/**
 * apps/mobile/src/screens/CourseScreen.tsx
 * consume-only, no builder (F3)
 */
import React, { useCallback } from 'react';
import { View, Text, SectionList, Pressable, ActivityIndicator, StyleSheet } from 'react-native';
import { useCourse } from '@classroom/core-client';
import type { Lesson, CourseModule } from '@classroom/contracts';
import type { ScreenProps } from '../navigation/types';

export default function CourseScreen({ route, navigation }: ScreenProps<'Course'>) {
  const { courseId } = route.params;
  const { course, loading, error, markLessonComplete, resumeLesson } = useCourse(courseId);

  const openLesson = useCallback(
    (lesson: Lesson) => {
      if (lesson.type === 'live' && lesson.liveRoomId) {
        navigation.navigate('Classroom', { roomId: lesson.liveRoomId, lessonId: lesson.id });
      } else {
        void markLessonComplete(lesson.id);
        // video/doc/quiz playback is handled by CourseViewer components on web;
        // on mobile this screen focuses on curriculum navigation + progress.
      }
    },
    [navigation, markLessonComplete],
  );

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator />
      </View>
    );
  }

  if (error || !course) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorText}>{error ?? 'Kurs konnte nicht geladen werden.'}</Text>
      </View>
    );
  }

  const sections = course.modules.map((m: CourseModule) => ({ title: m.title, data: m.lessons }));

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>{course.title}</Text>
        <View style={styles.progressTrack}>
          <View style={[styles.progressFill, { width: `${course.progressPercent}%` }]} />
        </View>
        <Text style={styles.progressLabel}>{course.progressPercent}% abgeschlossen</Text>
      </View>

      {resumeLesson && (
        <Pressable style={styles.resumeCard} onPress={() => openLesson(resumeLesson)}>
          <Text style={styles.resumeLabel}>Weitermachen</Text>
          <Text style={styles.resumeTitle}>{resumeLesson.title}</Text>
        </Pressable>
      )}

      <SectionList
        sections={sections}
        keyExtractor={(item) => item.id}
        renderSectionHeader={({ section }) => (
          <Text style={styles.sectionHeader}>{section.title}</Text>
        )}
        renderItem={({ item }) => (
          <Pressable style={styles.lessonRow} onPress={() => openLesson(item)}>
            <View style={[styles.checkbox, item.completed && styles.checkboxDone]} />
            <View style={styles.lessonInfo}>
              <Text style={styles.lessonTitle}>{item.title}</Text>
              <Text style={styles.lessonMeta}>
                {item.type === 'live' ? 'Live-Session' : item.type.toUpperCase()}
              </Text>
            </View>
          </Pressable>
        )}
      />

      {course.certificateUrl && (
        <Text style={styles.certNote}>Zertifikat verfügbar — auf dem Web-Client herunterladbar.</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  errorText: { color: '#B3261E' },
  header: { padding: 16, borderBottomWidth: 1, borderBottomColor: '#EEE' },
  title: { fontSize: 20, fontWeight: '700', marginBottom: 8 },
  progressTrack: { height: 6, borderRadius: 3, backgroundColor: '#EEE', overflow: 'hidden' },
  progressFill: { height: 6, backgroundColor: '#4C6FFF' },
  progressLabel: { marginTop: 6, fontSize: 12, color: '#666' },
  resumeCard: { margin: 16, padding: 14, borderRadius: 12, backgroundColor: '#EEF1FF' },
  resumeLabel: { fontSize: 11, color: '#4C6FFF', fontWeight: '600', textTransform: 'uppercase' },
  resumeTitle: { fontSize: 16, fontWeight: '600', marginTop: 2 },
  sectionHeader: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 4, fontSize: 13, fontWeight: '700', color: '#888' },
  lessonRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10 },
  checkbox: { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: '#CCC', marginRight: 12 },
  checkboxDone: { backgroundColor: '#4C6FFF', borderColor: '#4C6FFF' },
  lessonInfo: { flex: 1 },
  lessonTitle: { fontSize: 15, fontWeight: '500' },
  lessonMeta: { fontSize: 12, color: '#888', marginTop: 2 },
  certNote: { padding: 16, fontSize: 12, color: '#666', textAlign: 'center' },
});