/**
 * infra/ecs-api.tf [EXT] + collab / realtime target group
 * Two Fargate services from the same image (server/Dockerfile.api): "api"
 * answers REST + is the ALB's default target; "realtime" answers Yjs/collab/
 * presence over the same image but a different entrypoint flag, isolated
 * into its own service and target group so a busy course builder cannot
 * evict request-handling capacity (see section 7.1 of the architecture doc).
 */

resource "aws_ecs_task_definition" "api" {
  family                   = "${local.name_prefix}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.api_task_cpu
  memory                   = var.api_task_memory
  execution_role_arn       = aws_iam_role.ecs_task_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([{
    name  = "api"
    image = var.api_image
    portMappings = [{ containerPort = var.container_port, protocol = "tcp" }]
    environment = [
      { name = "NODE_ENV", value = "production" },
      { name = "SERVICE_NAME", value = "api" },
      { name = "PORT", value = tostring(var.container_port) },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.ecs["api"].name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "api"
      }
    }
  }])
}

resource "aws_ecs_service" "api" {
  name            = "${local.name_prefix}-api"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = var.api_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets         = aws_subnet.private[*].id
    security_groups = [aws_security_group.ecs_tasks.id]
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name    = "api"
    container_port    = var.container_port
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
}

resource "aws_ecs_task_definition" "realtime" {
  family                   = "${local.name_prefix}-realtime"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.api_task_cpu
  memory                   = var.api_task_memory
  execution_role_arn       = aws_iam_role.ecs_task_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([{
    name  = "realtime"
    image = var.api_image
    command = ["node", "server/src/realtime/collabServer.js"]
    portMappings = [{ containerPort = var.container_port, protocol = "tcp" }]
    environment = [
      { name = "NODE_ENV", value = "production" },
      { name = "SERVICE_NAME", value = "realtime" },
      { name = "PORT", value = tostring(var.container_port) },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.ecs["realtime"].name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "realtime"
      }
    }
  }])
}

resource "aws_ecs_service" "realtime" {
  name            = "${local.name_prefix}-realtime"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.realtime.arn
  desired_count   = var.api_desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets         = aws_subnet.private[*].id
    security_groups = [aws_security_group.ecs_tasks.id]
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.realtime.arn
    container_name    = "realtime"
    container_port    = var.container_port
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
}