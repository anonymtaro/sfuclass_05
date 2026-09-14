/**
 * infra/ecs-cluster.tf [NEW] Fargate + EC2 capacity provider
 * One cluster, two capacity providers: FARGATE for api/realtime/worker
 * (stateless, no host access needed) and an EC2 Auto Scaling Group for the
 * SFU, which needs host networking and a fixed UDP port range that Fargate
 * cannot expose (see ecs-sfu.tf).
 */

resource "aws_ecs_cluster" "main" {
  name = "${local.name_prefix}-cluster"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = { Name = "${local.name_prefix}-cluster" }
}

resource "aws_ecs_cluster_capacity_providers" "main" {
  cluster_name = aws_ecs_cluster.main.name

  capacity_providers = ["FARGATE", "FARGATE_SPOT", aws_ecs_capacity_provider.sfu.name]

  default_capacity_provider_strategy {
    base              = 0
    weight            = 1
    capacity_provider = "FARGATE"
  }
}

resource "aws_ecs_capacity_provider" "sfu" {
  name = "${local.name_prefix}-sfu-cp"

  auto_scaling_group_provider {
    auto_scaling_group_arn         = aws_autoscaling_group.sfu.arn
    managed_termination_protection = "DISABLED" # rooms drain via lifecycle/drainSfu.js, not ASG protection

    managed_scaling {
      status                    = "ENABLED"
      target_capacity           = 100
      minimum_scaling_step_size = 1
      maximum_scaling_step_size = 1
    }
  }
}

# ---- Shared execution role: every task pulls its image and reads secrets with this ----
resource "aws_iam_role" "ecs_task_execution" {
  name = "${local.name_prefix}-ecs-execution-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ecs_task_execution_managed" {
  role       = aws_iam_role.ecs_task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "ecs_task_execution_secrets" {
  name = "${local.name_prefix}-ecs-execution-secrets"
  role = aws_iam_role.ecs_task_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = "arn:aws:secretsmanager:${var.aws_region}:*:secret:${local.name_prefix}-*"
    }]
  })
}

resource "aws_cloudwatch_log_group" "ecs" {
  for_each          = toset(["api", "realtime", "worker", "sfu"])
  name              = "/ecs/${local.name_prefix}-${each.key}"
  retention_in_days = var.environment == "prod" ? 90 : 14
  kms_key_id        = aws_kms_key.logs.arn

  tags = { Name = "${local.name_prefix}-${each.key}-logs" }
}