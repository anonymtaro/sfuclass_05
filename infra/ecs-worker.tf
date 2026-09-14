/**
 * infra/ecs-worker.tf [NEW] recording + BullMQ workers (F4,F7)
 * No load balancer - this service only pulls from BullMQ queues on Redis
 * (queues/, jobs/workers/*). ffmpeg lives in server/Dockerfile.worker, used
 * by recordingWorker.js and transcodeWorker.js.
 */

resource "aws_ecs_task_definition" "worker" {
  family                   = "${local.name_prefix}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.worker_task_cpu
  memory                   = var.worker_task_memory
  execution_role_arn       = aws_iam_role.ecs_task_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([{
    name  = "worker"
    image = var.worker_image
    environment = [
      { name = "NODE_ENV", value = "production" },
      { name = "SERVICE_NAME", value = "worker" },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.ecs["worker"].name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "worker"
      }
    }
  }])
}

resource "aws_ecs_service" "worker" {
  name            = "${local.name_prefix}-worker"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.worker.arn
  desired_count   = var.worker_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets         = aws_subnet.private[*].id
    security_groups = [aws_security_group.ecs_tasks.id]
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
}