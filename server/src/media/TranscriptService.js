// classroom-app/server/src/media/TranscriptService.js
/**
 * Captions  (F4)  [NEW]
 *
 * Amazon Transcribe turns a lecture into a WebVTT track.
 *
 * Captions are an accessibility requirement before they are a feature, and
 * they are also the only way a two-hour lecture becomes searchable. That is why
 * the transcript text is indexed as well as rendered: a learner looking for the
 * five minutes where the lecturer explained recursion should not have to scrub.
 *
 * The job never blocks playback. A video is `ready` when it has been
 * transcoded; captions arrive afterwards and are attached to the asset in
 * place. A failure here is logged and left — an uncaptioned video is worse than
 * a captioned one and far better than none.
 */

import { env } from '../config/env.js';
import { buckets } from '../config/storage.config.js';
import { logger } from '../observability/logger.js';
import * as Assets from './models/Asset.js';
import * as Storage from './StorageClient.js';

const log = logger.child({ component: 'transcripts' });

/** Machine transcription below this is worse than nothing. */
const MIN_CONFIDENCE = 0.6;

// ---------------------------------------------------------------------------
// VTT  (pure)
// ---------------------------------------------------------------------------

/** 73.456 → '00:01:13.456' */
export const formatTimestamp = (seconds) => {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const wholeSeconds = Math.floor(seconds % 60);
  const milliseconds = Math.round((seconds % 1) * 1000);

  return [
    String(hours).padStart(2, '0'),
    String(minutes).padStart(2, '0'),
    `${String(wholeSeconds).padStart(2, '0')}.${String(milliseconds).padStart(3, '0')}`,
  ].join(':');
};

/**
 * Groups Transcribe's word-level output into readable cues.
 *
 * Two constraints, and both matter on a phone: a cue is at most two lines of
 * about forty characters, and it lasts at least a second — a cue that flashes
 * for 200ms is unreadable, and one that runs to six lines covers the slide.
 */
export const buildVtt = (items, { maxChars = 80, maxSeconds = 6 } = {}) => {
  const cues = [];
  let current = null;

  for (const item of items) {
    const alternative = item.alternatives?.[0];
    if (!alternative) continue;

    const isPunctuation = item.type === 'punctuation';
    const start = Number(item.start_time ?? current?.start ?? 0);
    const end = Number(item.end_time ?? start);

    if (!current) {
      current = { start, end, text: alternative.content };
      continue;
    }

    // Punctuation joins the preceding word rather than starting a cue with it.
    const candidate = isPunctuation
      ? `${current.text}${alternative.content}`
      : `${current.text} ${alternative.content}`;

    const tooLong = candidate.length > maxChars;
    const tooSlow = end - current.start > maxSeconds;
    // A sentence ending is the natural place to break, and reads far better
    // than breaking at a character count.
    const sentenceEnded = isPunctuation && /[.!?]/.test(alternative.content);

    if (!isPunctuation && (tooLong || tooSlow)) {
      cues.push(current);
      current = { start, end, text: alternative.content };
    } else {
      current.text = candidate;
      current.end = end;
      if (sentenceEnded && current.text.length > maxChars * 0.5) {
        cues.push(current);
        current = null;
      }
    }
  }

  if (current) cues.push(current);

  const body = cues
    .map((cue, index) =>
      [
        String(index + 1),
        `${formatTimestamp(cue.start)} --> ${formatTimestamp(Math.max(cue.end, cue.start + 1))}`,
        cue.text.trim(),
      ].join('\n'),
    )
    .join('\n\n');

  return `WEBVTT\n\n${body}\n`;
};

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export const requestTranscript = async ({ assetId, language = 'auto' }) => {
  const asset = await Assets.findById(assetId);
  if (!asset) return { skipped: true };
  if (asset.kind !== 'video' && asset.kind !== 'audio') {
    return { skipped: true, reason: 'nothing to transcribe' };
  }

  if (!env.AWS_REGION || env.ANTIVIRUS_MODE === 'disabled') {
    // Development: no Transcribe, and no reason to pretend otherwise.
    return { skipped: true, reason: 'transcription not configured' };
  }

  const { TranscribeClient, StartTranscriptionJobCommand } = await import('@aws-sdk/client-transcribe');
  const client = new TranscribeClient({ region: env.AWS_REGION });

  // Transcribe job names are globally unique per account and cannot be reused,
  // so the asset id alone would collide on a retry.
  const jobName = `classroom-${assetId}-${Date.now()}`;

  await client.send(
    new StartTranscriptionJobCommand({
      TranscriptionJobName: jobName,
      Media: { MediaFileUri: `s3://${buckets.delivery}/${asset.objectKey}` },
      OutputBucketName: buckets.delivery,
      OutputKey: `${asset.objectKey.replace(/\.[^.]+$/, '')}/transcript/raw.json`,
      ...(language === 'auto'
        ? { IdentifyLanguage: true, LanguageOptions: ['en-US', 'en-GB', 'de-DE', 'fr-FR', 'es-ES'] }
        : { LanguageCode: language }),
      Settings: {
        // Who said what. Worth having for a seminar; meaningless for a lecture,
        // and harmless either way.
        ShowSpeakerLabels: true,
        MaxSpeakerLabels: 10,
      },
    }),
  );

  log.info({ assetId, jobName, language }, 'transcription requested');
  return { jobName };
};

/**
 * Called when the job finishes. Reads Transcribe's JSON, writes a VTT beside
 * the video, and attaches it to the asset.
 */
export const completeTranscript = async ({ assetId, jobName, transcriptKey, language = 'en' }) => {
  const asset = await Assets.findById(assetId);
  if (!asset) return { skipped: true };

  const stream = await Storage.getObjectStream({ bucket: 'delivery', key: transcriptKey });
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const raw = JSON.parse(Buffer.concat(chunks).toString('utf8'));

  const items = raw.results?.items ?? [];
  const confidence = averageConfidence(items);

  // A transcript nobody can rely on is worse than none: learners quote
  // captions, and a wrong quote is worse than a missing one.
  if (confidence < MIN_CONFIDENCE) {
    log.warn({ assetId, confidence }, 'transcript confidence too low; discarded');
    return { skipped: true, reason: 'low confidence', confidence };
  }

  const vtt = buildVtt(items);
  const vttKey = `${asset.objectKey.replace(/\.[^.]+$/, '')}/captions/${language}.vtt`;

  await Storage.putObject({
    bucket: 'delivery',
    key: vttKey,
    body: Buffer.from(vtt, 'utf8'),
    contentType: 'text/vtt',
  });

  const captions = [
    ...(asset.captions ?? []).filter((track) => track.language !== language),
    { language, label: labelFor(language), key: vttKey, source: 'auto' },
  ];

  await Assets.setStatus({ assetId, to: asset.status, patch: { captions } });

  // The searchable copy. This is what makes "find the bit about recursion"
  // work across a course's whole video library.
  await indexTranscript({ asset, text: raw.results?.transcripts?.[0]?.transcript ?? '', language });

  log.info({ assetId, language, confidence, cues: vtt.split('\n\n').length }, 'captions attached');

  notify(assetId, 'media:transcript.ready', {
    assetId,
    language,
    url: vttKey,
    source: 'auto',
  });

  return { language, key: vttKey, confidence };
};

/** A human-supplied replacement always wins over the machine's version. */
export const uploadCaptions = async ({ assetId, language, vtt, actorId }) => {
  const asset = await Assets.findById(assetId);
  if (!asset) throw Object.assign(new Error('asset not found'), { code: 'not_found' });

  if (!vtt.trimStart().startsWith('WEBVTT')) {
    throw Object.assign(new Error('captions must be a WebVTT file'), { code: 'validation_failed' });
  }

  const key = `${asset.objectKey.replace(/\.[^.]+$/, '')}/captions/${language}.vtt`;
  await Storage.putObject({ bucket: 'delivery', key, body: Buffer.from(vtt, 'utf8'), contentType: 'text/vtt' });

  const captions = [
    ...(asset.captions ?? []).filter((track) => track.language !== language),
    { language, label: labelFor(language), key, source: 'manual' },
  ];

  await Assets.setStatus({ assetId, to: asset.status, patch: { captions } });
  log.info({ assetId, language, actorId }, 'captions replaced by hand');

  return { language, key };
};

const averageConfidence = (items) => {
  const scored = items
    .filter((item) => item.type === 'pronunciation')
    .map((item) => Number(item.alternatives?.[0]?.confidence ?? 0));

  if (scored.length === 0) return 0;
  return scored.reduce((total, value) => total + value, 0) / scored.length;
};

const indexTranscript = async ({ asset, text, language }) => {
  if (!text || !env.SEARCH_ENABLED) return;

  const { indexDocument } = await import('../community/FeedService.js').then(() =>
    import('../messaging/ChatSearchService.js'),
  );

  await indexDocument({
    index: 'transcripts',
    id: asset.assetId,
    body: {
      assetId: asset.assetId,
      ownerId: asset.ownerId,
      purpose: asset.purpose,
      contextId: asset.metadata?.lessonId ?? null,
      language,
      text,
    },
  }).catch((cause) => log.error({ err: cause, assetId: asset.assetId }, 'transcript not indexed'));
};

const LANGUAGE_LABELS = {
  en: 'English', 'en-US': 'English', 'en-GB': 'English',
  de: 'Deutsch', 'de-DE': 'Deutsch',
  fr: 'Français', es: 'Español',
};

const labelFor = (language) => LANGUAGE_LABELS[language] ?? language;

const notify = (assetId, event, payload) => {
  void import('../realtime/presenceGateway.js')
    .then(({ broadcastToAssetWatchers }) => broadcastToAssetWatchers(assetId, event, payload))
    .catch(() => undefined);
};

export default { requestTranscript, completeTranscript, uploadCaptions, buildVtt, formatTimestamp };