/**
 * infra/iam.tf [EXT] + S3 · MediaConvert · SNS · SES roles
 * ecs-cluster.tf's aws_iam_role.ecs_task_execution only pulls images and
 * reads secrets - it can't call AWS APIs from inside the app. This is the
 * task role the running Node.js process actually assumes: presigning S3
 * uploads, starting MediaConvert jobs, publishing push notifications, and
 * sending mail through SES.
 */

resource "aws_iam_role" "ecs_task" {
  name = "${local.name_prefix}-ecs-task-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = { Name = "${local.name_prefix}-ecs-task-role" }
}

resource "aws_iam_role_policy" "ecs_task_s3_media" {
  name = "${local.name_prefix}-task-s3-media"
  role = aws_iam_role.ecs_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"]
      Resource = [
        "${aws_s3_bucket.raw.arn}/*",
        "${aws_s3_bucket.quarantine.arn}/*",
        "${aws_s3_bucket.delivery.arn}/*",
      ]
    }]
  })
}

resource "aws_iam_role_policy" "ecs_task_mediaconvert" {
  name = "${local.name_prefix}-task-mediaconvert"
  role = aws_iam_role.ecs_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["mediaconvert:CreateJob", "mediaconvert:GetJob", "mediaconvert:ListJobs"]
        Resource = "*"
      },
      {
        Effect   = "Allow"
        Action   = ["iam:PassRole"]
        Resource = [aws_iam_role.mediaconvert.arn, aws_iam_role.transcribe.arn]
      },
      {
        Effect   = "Allow"
        Action   = ["transcribe:StartTranscriptionJob", "transcribe:GetTranscriptionJob"]
        Resource = "*"
      },
    ]
  })
}

resource "aws_iam_role_policy" "ecs_task_sns_ses" {
  name = "${local.name_prefix}-task-sns-ses"
  role = aws_iam_role.ecs_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "PushNotifications"
        Effect   = "Allow"
        Action   = ["sns:Publish", "sns:CreatePlatformEndpoint", "sns:DeleteEndpoint"]
        Resource = [aws_sns_platform_application.apns.arn, aws_sns_platform_application.fcm.arn, "*"]
      },
      {
        Sid      = "TransactionalEmail"
        Effect   = "Allow"
        Action   = ["ses:SendEmail", "ses:SendRawEmail"]
        Resource = "*"
        Condition = {
          StringEquals = { "ses:FromAddress" = "noreply@${var.domain_name}" }
        }
      },
    ]
  })
}

resource "aws_iam_role_policy" "ecs_task_queue_metrics" {
  name = "${local.name_prefix}-task-queue-metrics"
  role = aws_iam_role.ecs_task.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["cloudwatch:PutMetricData"]
      Resource = "*"
      Condition = {
        StringEquals = { "cloudwatch:namespace" = ["ClassroomPlatform/Queues", "ClassroomPlatform/SFU"] }
      }
    }]
  })
}