/**
 * infra/turn.tf [UNCHANGED] coturn ASG (F1)
 * Relay fallback for networks that block UDP outright (the SFU's own TCP:443
 * TURN listener in security-groups.tf/ecs-sfu.tf handles the common case;
 * this is the dedicated coturn fleet for the harder cases). Independent
 * lifecycle from the SFU - it scales and restarts on its own schedule.
 */

resource "aws_security_group" "turn" {
  name        = "${local.name_prefix}-turn-sg"
  description = "coturn: STUN/TURN over UDP+TCP 3478 and TLS 5349"
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "STUN/TURN"
    from_port   = 3478
    to_port     = 3478
    protocol    = "udp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    from_port   = 3478
    to_port     = 3478
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    description = "TURNS (TLS)"
    from_port   = 5349
    to_port     = 5349
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    description = "Relay port range"
    from_port   = 49152
    to_port     = 65535
    protocol    = "udp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${local.name_prefix}-turn-sg" }
}

resource "aws_iam_role" "turn_instance" {
  name = "${local.name_prefix}-turn-instance-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "turn_instance_secret" {
  name = "${local.name_prefix}-turn-instance-secret"
  role = aws_iam_role.turn_instance.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = aws_secretsmanager_secret.turn_shared_secret.arn
    }]
  })
}

resource "aws_iam_instance_profile" "turn" {
  name = "${local.name_prefix}-turn-profile"
  role = aws_iam_role.turn_instance.name
}

resource "aws_launch_template" "turn" {
  name_prefix   = "${local.name_prefix}-turn-"
  image_id      = data.aws_ami.ecs_optimized.id # any recent Amazon Linux 2 image; coturn installs via user_data, not ECS
  instance_type = var.turn_instance_type

  iam_instance_profile {
    arn = aws_iam_instance_profile.turn.arn
  }

  network_interfaces {
    associate_public_ip_address = true
    security_groups             = [aws_security_group.turn.id]
  }

  user_data = base64encode("#!/bin/bash\nyum install -y coturn\nSECRET=$(aws secretsmanager get-secret-value --secret-id ${aws_secretsmanager_secret.turn_shared_secret.id} --query SecretString --output text --region ${var.aws_region})\necho \"use-auth-secret\" >> /etc/turnserver.conf\necho \"static-auth-secret=$SECRET\" >> /etc/turnserver.conf\necho \"realm=turn.${var.domain_name}\" >> /etc/turnserver.conf\nsystemctl enable coturn\nsystemctl start coturn\n")

  tag_specifications {
    resource_type = "instance"
    tags          = { Name = "${local.name_prefix}-turn-node" }
  }
}

resource "aws_autoscaling_group" "turn" {
  name                = "${local.name_prefix}-turn-asg"
  vpc_zone_identifier = aws_subnet.public[*].id
  min_size            = 1
  max_size            = 3
  desired_capacity    = 1

  launch_template {
    id      = aws_launch_template.turn.id
    version = "$Latest"
  }

  tag {
    key                 = "Name"
    value               = "${local.name_prefix}-turn-node"
    propagate_at_launch = true
  }
}