/**
 * infra/autoscaling.tf [NEW] target tracking: CPU · rooms · queue
 * Matches section 7.2 of the architecture doc exactly: api on CPU, worker
 * on queue depth, sfu on active rooms/producers per node.
 */

# ---- api: CPU 60%, 2 to 10 tasks ----
resource "aws_appautoscaling_target" "api" {
  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.api.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = var.api_desired_count
  max_capacity       = 10
}

resource "aws_appautoscaling_policy" "api_cpu" {
  name               = "${local.name_prefix}-api-cpu"
  service_namespace  = aws_appautoscaling_target.api.service_namespace
  resource_id        = aws_appautoscaling_target.api.resource_id
  scalable_dimension = aws_appautoscaling_target.api.scalable_dimension
  policy_type        = "TargetTrackingScaling"

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
    target_value       = 60
    scale_in_cooldown  = 120
    scale_out_cooldown = 60
  }
}

# ---- worker: step scaling on BullMQ queue depth, 1 to 8 tasks, scale to 1 overnight ----
resource "aws_appautoscaling_target" "worker" {
  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.worker.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = 1
  max_capacity       = 8
}

resource "aws_appautoscaling_policy" "worker_queue_depth" {
  name               = "${local.name_prefix}-worker-queue-depth"
  service_namespace  = aws_appautoscaling_target.worker.service_namespace
  resource_id        = aws_appautoscaling_target.worker.resource_id
  scalable_dimension = aws_appautoscaling_target.worker.scalable_dimension
  policy_type        = "StepScaling"

  step_scaling_policy_configuration {
    adjustment_type         = "ChangeInCapacity"
    cooldown                = 90
    metric_aggregation_type = "Average"

    step_adjustment {
      metric_interval_lower_bound = 0
      scaling_adjustment          = 1
    }
    step_adjustment {
      metric_interval_lower_bound = 50
      scaling_adjustment          = 3
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "worker_queue_depth_high" {
  alarm_name          = "${local.name_prefix}-worker-queue-depth-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "QueueDepth"          # published by queues/queues.js -> CloudWatch (observability/metrics.js)
  namespace           = "ClassroomPlatform/Queues"
  period              = 60
  statistic           = "Average"
  threshold           = 20
  alarm_actions       = [aws_appautoscaling_policy.worker_queue_depth.arn]

  dimensions = { Environment = var.environment }
}

# ---- sfu: target tracking on rooms/producers per node ----
resource "aws_autoscaling_policy" "sfu_rooms_per_node" {
  name                      = "${local.name_prefix}-sfu-rooms-per-node"
  autoscaling_group_name    = aws_autoscaling_group.sfu.name
  policy_type               = "TargetTrackingScaling"
  estimated_instance_warmup = 120

  target_tracking_configuration {
    customized_metric_specification {
      metric_name = "ActiveProducersPerNode" # published by mediasoup/health.js
      namespace   = "ClassroomPlatform/SFU"
      statistic   = "Average"
    }
    target_value = 150 # add a node before saturation, per section 7.2
  }
}