/**
 * infra/ecs-sfu.tf [UNCHANGED] host network, UDP range, NLB (F1)
 * ECS on EC2 (not Fargate) because mediasoup needs a fixed UDP port range
 * and host networking, which Fargate cannot expose. The NLB passes the
 * client's real source IP straight through - that is why the SFU's own
 * security group (security-groups.tf) carries the actual restriction.
 */

data "aws_ami" "ecs_optimized" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["amzn2-ami-ecs-hvm-*-x86_64-ebs"]
  }
}

resource "aws_iam_role" "sfu_instance" {
  name = "${local.name_prefix}-sfu-instance-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "sfu_instance_ecs" {
  role       = aws_iam_role.sfu_instance.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonEC2ContainerServiceforEC2Role"
}

resource "aws_iam_instance_profile" "sfu" {
  name = "${local.name_prefix}-sfu-profile"
  role = aws_iam_role.sfu_instance.name
}

resource "aws_launch_template" "sfu" {
  name_prefix   = "${local.name_prefix}-sfu-"
  image_id      = data.aws_ami.ecs_optimized.id
  instance_type = var.sfu_instance_type

  iam_instance_profile {
    arn = aws_iam_instance_profile.sfu.arn
  }

  network_interfaces {
    associate_public_ip_address = false
    security_groups             = [aws_security_group.sfu.id]
  }

  user_data = base64encode("#!/bin/bash\necho ECS_CLUSTER=${aws_ecs_cluster.main.name} >> /etc/ecs/ecs.config\necho ECS_ENABLE_TASK_ENI=false >> /etc/ecs/ecs.config\n")

  tag_specifications {
    resource_type = "instance"
    tags          = { Name = "${local.name_prefix}-sfu-node" }
  }
}

resource "aws_autoscaling_group" "sfu" {
  name                  = "${local.name_prefix}-sfu-asg"
  vpc_zone_identifier   = aws_subnet.private[*].id
  min_size              = var.sfu_min_size
  max_size              = var.sfu_max_size
  desired_capacity      = var.sfu_desired_capacity
  protect_from_scale_in = true

  launch_template {
    id      = aws_launch_template.sfu.id
    version = "$Latest"
  }

  tag {
    key                 = "AmazonECSManaged"
    value               = "true"
    propagate_at_launch = true
  }
}

resource "aws_lb" "sfu" {
  name               = "${local.name_prefix}-sfu-nlb"
  internal           = false
  load_balancer_type = "network"
  subnets            = aws_subnet.public[*].id

  tags = { Name = "${local.name_prefix}-sfu-nlb" }
}

resource "aws_lb_target_group" "sfu_media" {
  name        = "${local.name_prefix}-sfu-media-tg"
  port        = 40000
  protocol    = "UDP"
  vpc_id      = aws_vpc.main.id
  target_type = "instance"

  health_check {
    protocol = "TCP"
    port     = "443"
  }
}

resource "aws_lb_listener" "sfu_media" {
  load_balancer_arn = aws_lb.sfu.arn
  port              = 40000
  protocol          = "UDP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.sfu_media.arn
  }
}

resource "aws_ecs_task_definition" "sfu" {
  family                   = "${local.name_prefix}-sfu"
  requires_compatibilities = ["EC2"]
  network_mode             = "host"
  execution_role_arn       = aws_iam_role.ecs_task_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([{
    name  = "sfu"
    image = var.sfu_image
    portMappings = [
      { containerPort = 40000, hostPort = 40000, protocol = "udp" },
      { containerPort = 443, hostPort = 443, protocol = "tcp" },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.ecs["sfu"].name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "sfu"
      }
    }
  }])
}

resource "aws_ecs_service" "sfu" {
  name            = "${local.name_prefix}-sfu"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.sfu.arn
  desired_count   = var.sfu_desired_capacity
  launch_type     = "EC2"

  load_balancer {
    target_group_arn = aws_lb_target_group.sfu_media.arn
    container_name    = "sfu"
    container_port    = 40000
  }

  deployment_maximum_percent         = 100
  deployment_minimum_healthy_percent = 0
}