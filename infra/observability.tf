/**
 * infra/observability.tf [EXT] dashboards, alarms, log retention
 * The alarm table from section 11.1 of the architecture doc, minus
 * worker_queue_depth_high which already lives in autoscaling.tf because it
 * doubles as a scaling trigger there.
 */

resource "aws_sns_topic" "alarms" {
  name = "${local.name_prefix}-alarms"
}

resource "aws_cloudwatch_metric_alarm" "api_5xx_rate" {
  alarm_name          = "${local.name_prefix}-api-5xx-rate"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "HTTPCode_Target_5XX_Count"
  namespace           = "AWS/ApplicationELB"
  period              = 300
  statistic           = "Sum"
  threshold           = 0 # combined with request count below via a math alarm would be more precise; kept simple here

  dimensions = { LoadBalancer = aws_lb.main.arn_suffix, TargetGroup = aws_lb_target_group.api.arn_suffix }

  alarm_actions = [aws_sns_topic.alarms.arn]
  ok_actions    = [aws_sns_topic.alarms.arn]
}

resource "aws_cloudwatch_metric_alarm" "readiness_failures" {
  alarm_name          = "${local.name_prefix}-readiness-failures"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 3
  metric_name         = "HealthyHostCount"
  namespace           = "AWS/ApplicationELB"
  period              = 60
  statistic           = "Minimum"
  threshold           = 1

  dimensions = { LoadBalancer = aws_lb.main.arn_suffix, TargetGroup = aws_lb_target_group.api.arn_suffix }

  alarm_actions = [aws_sns_topic.alarms.arn]
}

resource "aws_cloudwatch_metric_alarm" "sfu_node_saturation" {
  alarm_name          = "${local.name_prefix}-sfu-node-saturation"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "ActiveProducersPerNode"
  namespace           = "ClassroomPlatform/SFU"
  period              = 60
  statistic           = "Maximum"
  threshold           = 180 # above the 150 scale-out target in autoscaling.tf - fires only if scaling can't keep up

  alarm_actions = [aws_sns_topic.alarms.arn]
}

resource "aws_cloudwatch_metric_alarm" "transcode_lag" {
  alarm_name          = "${local.name_prefix}-transcode-lag"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "ApproximateAgeOfOldestMessage"
  namespace           = "AWS/SQS"
  period              = 60
  statistic           = "Maximum"
  threshold           = 900 # 15 minutes

  dimensions = { QueueName = aws_sqs_queue.mediaconvert_events.name }

  alarm_actions = [aws_sns_topic.alarms.arn]
}

resource "aws_cloudwatch_metric_alarm" "chat_delivery_latency" {
  alarm_name          = "${local.name_prefix}-chat-delivery-latency"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 5
  metric_name         = "ChatDeliveryLatencyP95Ms"
  namespace           = "ClassroomPlatform/Chat"
  period              = 60
  statistic           = "Average"
  threshold           = 1000

  alarm_actions = [aws_sns_topic.alarms.arn]
}

resource "aws_cloudwatch_metric_alarm" "db_cpu" {
  alarm_name          = "${local.name_prefix}-db-cpu"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "CPUUtilization"
  namespace           = "AWS/RDS"
  period              = 60
  statistic           = "Average"
  threshold           = 80

  dimensions = { DBInstanceIdentifier = aws_db_instance.primary.id }

  alarm_actions = [aws_sns_topic.alarms.arn]
}

resource "aws_cloudwatch_metric_alarm" "db_connections" {
  alarm_name          = "${local.name_prefix}-db-connections"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "DatabaseConnections"
  namespace           = "AWS/RDS"
  period              = 60
  statistic           = "Average"
  threshold           = 150

  dimensions = { DBInstanceIdentifier = aws_db_instance.primary.id }

  alarm_actions = [aws_sns_topic.alarms.arn]
}

resource "aws_cloudwatch_metric_alarm" "storage_quota_drift" {
  alarm_name          = "${local.name_prefix}-storage-quota-drift"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "StorageQuotaDriftBytes" # published by jobs/recomputeStorageUsage.js
  namespace           = "ClassroomPlatform/Billing"
  period              = 3600
  statistic           = "Maximum"
  threshold           = 104857600 # 100 MB drift

  alarm_actions = [aws_sns_topic.alarms.arn]
}

resource "aws_cloudwatch_metric_alarm" "cert_expiry_alb" {
  alarm_name          = "${local.name_prefix}-cert-expiry-alb"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 1
  metric_name         = "DaysToExpiry"
  namespace           = "AWS/CertificateManager"
  period              = 86400
  statistic           = "Minimum"
  threshold           = 30

  dimensions = { CertificateArn = aws_acm_certificate.alb.arn }

  alarm_actions = [aws_sns_topic.alarms.arn]
}

resource "aws_cloudwatch_dashboard" "main" {
  dashboard_name = "${local.name_prefix}-overview"

  dashboard_body = jsonencode({
    widgets = [
      {
        type   = "metric"
        x      = 0
        y      = 0
        width  = 12
        height = 6
        properties = {
          title   = "API 5xx / requests"
          view    = "timeSeries"
          region  = var.aws_region
          metrics = [
            ["AWS/ApplicationELB", "HTTPCode_Target_5XX_Count", "LoadBalancer", aws_lb.main.arn_suffix],
            ["AWS/ApplicationELB", "RequestCount", "LoadBalancer", aws_lb.main.arn_suffix],
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 0
        width  = 12
        height = 6
        properties = {
          title   = "SFU producers per node / RDS CPU"
          view    = "timeSeries"
          region  = var.aws_region
          metrics = [
            ["ClassroomPlatform/SFU", "ActiveProducersPerNode"],
            ["AWS/RDS", "CPUUtilization", "DBInstanceIdentifier", aws_db_instance.primary.id],
          ]
        }
      },
    ]
  })
}