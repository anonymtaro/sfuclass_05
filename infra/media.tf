/**
 * infra/media.tf [NEW] S3 raw / quarantine / delivery, MediaConvert, Transcribe, EventBridge
 * Upload flow: raw (presigned target) -> quarantine (until AntivirusScan.js
 * clears it) -> delivery (signed CloudFront URLs, short TTL). Versioning on,
 * lifecycle rules for old recordings and chat attachments per CHAT_RETENTION_DAYS.
 */

resource "aws_s3_bucket" "raw" {
  bucket = "${local.name_prefix}-media-raw"
  tags   = { Name = "${local.name_prefix}-media-raw" }
}

resource "aws_s3_bucket" "quarantine" {
  bucket = "${local.name_prefix}-media-quarantine"
  tags   = { Name = "${local.name_prefix}-media-quarantine" }
}

resource "aws_s3_bucket" "delivery" {
  bucket = "${local.name_prefix}-media-delivery"
  tags   = { Name = "${local.name_prefix}-media-delivery" }
}

resource "aws_s3_bucket_versioning" "delivery" {
  bucket = aws_s3_bucket.delivery.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_public_access_block" "media" {
  for_each                = { raw = aws_s3_bucket.raw.id, quarantine = aws_s3_bucket.quarantine.id, delivery = aws_s3_bucket.delivery.id }
  bucket                  = each.value
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Raw uploads are transient - if AntivirusScan.js never promotes them, they age out.
resource "aws_s3_bucket_lifecycle_configuration" "raw" {
  bucket = aws_s3_bucket.raw.id
  rule {
    id     = "expire-unscanned-uploads"
    status = "Enabled"
    expiration {
      days = 2
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "delivery" {
  bucket = aws_s3_bucket.delivery.id
  rule {
    id     = "chat-attachment-retention"
    status = "Enabled"
    filter {
      prefix = "chat-attachments/"
    }
    expiration {
      days = 365 # driven by CHAT_RETENTION_DAYS at the app layer; this is the outer bound
    }
  }
  rule {
    id     = "old-recordings-to-ia"
    status = "Enabled"
    filter {
      prefix = "recordings/"
    }
    transition {
      days          = 90
      storage_class = "STANDARD_IA"
    }
  }
}

# ---- MediaConvert: HLS transcoding, invoked by media/TranscodeService.js ----
resource "aws_iam_role" "mediaconvert" {
  name = "${local.name_prefix}-mediaconvert-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "mediaconvert.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "mediaconvert_s3" {
  name = "${local.name_prefix}-mediaconvert-s3"
  role = aws_iam_role.mediaconvert.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:GetObject", "s3:PutObject"]
      Resource = ["${aws_s3_bucket.quarantine.arn}/*", "${aws_s3_bucket.delivery.arn}/*"]
    }]
  })
}

resource "aws_media_convert_queue" "main" {
  name = "${local.name_prefix}-transcode"
}

# ---- Transcribe: captions/VTT generation, invoked by media/TranscriptService.js ----
resource "aws_iam_role" "transcribe" {
  name = "${local.name_prefix}-transcribe-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "transcribe.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "transcribe_s3" {
  name = "${local.name_prefix}-transcribe-s3"
  role = aws_iam_role.transcribe.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:GetObject", "s3:PutObject"]
      Resource = ["${aws_s3_bucket.quarantine.arn}/*", "${aws_s3_bucket.delivery.arn}/*"]
    }]
  })
}

# ---- EventBridge: MediaConvert job state change -> SQS -> mediaConvertWebhook.js ----
resource "aws_sqs_queue" "mediaconvert_events" {
  name                       = "${local.name_prefix}-mediaconvert-events"
  visibility_timeout_seconds = 60
}

resource "aws_cloudwatch_event_rule" "mediaconvert_job_state" {
  name = "${local.name_prefix}-mediaconvert-job-state"
  event_pattern = jsonencode({
    source      = ["aws.mediaconvert"]
    detail-type = ["MediaConvert Job State Change"]
    detail = {
      status = ["COMPLETE", "ERROR"]
      queue  = [aws_media_convert_queue.main.arn]
    }
  })
}

resource "aws_cloudwatch_event_target" "mediaconvert_to_sqs" {
  rule = aws_cloudwatch_event_rule.mediaconvert_job_state.name
  arn  = aws_sqs_queue.mediaconvert_events.arn
}

resource "aws_sqs_queue_policy" "mediaconvert_events" {
  queue_url = aws_sqs_queue.mediaconvert_events.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "events.amazonaws.com" }
      Action    = "sqs:SendMessage"
      Resource  = aws_sqs_queue.mediaconvert_events.arn
      Condition = {
        ArnEquals = { "aws:SourceArn" = aws_cloudwatch_event_rule.mediaconvert_job_state.arn }
      }
    }]
  })
}