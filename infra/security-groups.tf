/**
 * infra/security-groups.tf [NEW] least privilege, no public DB / Redis
 * Chain: internet -> alb_sg -> ecs_tasks_sg -> {rds_sg, redis_sg}.
 * RDS and Redis have no rule that references 0.0.0.0/0 anywhere, on purpose —
 * "Firewall" in section 12 of the architecture doc is enforced right here.
 */

# ---- ALB: HTTPS + WSS from the internet, nothing else ----
resource "aws_security_group" "alb" {
  name        = "${local.name_prefix}-alb-sg"
  description = "Public-facing ALB for HTTPS API traffic and WebSocket (Socket.IO) upgrades"
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "HTTPS / WSS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTP, redirected to HTTPS by the listener rule"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    description     = "Forward only to ECS tasks"
    from_port       = 0
    to_port         = 0
    protocol        = "-1"
    security_groups = [aws_security_group.ecs_tasks.id]
  }

  tags = { Name = "${local.name_prefix}-alb-sg" }
}

# ---- ECS tasks: api, realtime, worker services ----
resource "aws_security_group" "ecs_tasks" {
  name        = "${local.name_prefix}-ecs-tasks-sg"
  description = "Fargate tasks for api / realtime / worker — reachable only from the ALB"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "Application traffic from the ALB only"
    from_port       = 1024
    to_port         = 65535
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  egress {
    description = "Outbound to RDS, Redis, OpenSearch, VPC endpoints and the internet (via NAT)"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${local.name_prefix}-ecs-tasks-sg" }
}

# ---- SFU: media ports are reached directly by clients through the NLB, ----
# ---- which passes the client's source IP through unchanged (no SG on the ----
# ---- NLB itself) — so the SFU host's own SG carries the real restriction. ----
resource "aws_security_group" "sfu" {
  name        = "${local.name_prefix}-sfu-sg"
  description = "mediasoup SFU hosts — fixed UDP range for RTP/RTCP, TCP 443 as TURN-over-TCP fallback"
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "mediasoup RTP/RTCP UDP range"
    from_port   = 40000
    to_port     = 40100
    protocol    = "udp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "TURN over TCP 443 for networks that block UDP"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${local.name_prefix}-sfu-sg" }
}

# ---- RDS: reachable only from ECS tasks, on the Postgres port, nothing public ----
resource "aws_security_group" "rds" {
  name        = "${local.name_prefix}-rds-sg"
  description = "PostgreSQL — no route exists to it from outside the VPC"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "Postgres from ECS tasks only"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.ecs_tasks.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${local.name_prefix}-rds-sg" }
}

# ---- ElastiCache Redis: same shape as RDS ----
resource "aws_security_group" "redis" {
  name        = "${local.name_prefix}-redis-sg"
  description = "ElastiCache Redis — entitlements, presence, unread counters, BullMQ"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "Redis from ECS tasks only"
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [aws_security_group.ecs_tasks.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${local.name_prefix}-redis-sg" }
}

# ---- OpenSearch: chat / community / course search index ----
resource "aws_security_group" "opensearch" {
  name        = "${local.name_prefix}-opensearch-sg"
  description = "OpenSearch domain used by chat, community and course search"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "HTTPS from ECS tasks only"
    from_port       = 443
    to_port         = 443
    protocol        = "tcp"
    security_groups = [aws_security_group.ecs_tasks.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${local.name_prefix}-opensearch-sg" }
}