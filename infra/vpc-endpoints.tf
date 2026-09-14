/**
 * infra/vpc-endpoints.tf [NEW] S3 · ECR · Logs · Secrets (no NAT cost)
 * Every ECS task pulls its image, writes logs and reads secrets on every
 * boot. Without these endpoints that traffic would round-trip through the
 * NAT gateway (metered per GB); with them it stays on AWS's private network
 * and never touches the public internet at all.
 */

resource "aws_security_group" "vpc_endpoints" {
  name        = "${local.name_prefix}-vpce-sg"
  description = "Allows private subnets to reach interface VPC endpoints on 443"
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "HTTPS from inside the VPC only"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = { Name = "${local.name_prefix}-vpce-sg" }
}

# ---- Gateway endpoint: no ENI, no hourly cost, attached to route tables ----
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.${var.aws_region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = concat([aws_route_table.public.id], aws_route_table.private[*].id)

  tags = { Name = "${local.name_prefix}-vpce-s3" }
}

# ---- Interface endpoints: one ENI per subnet, billed per hour + per GB ----
locals {
  interface_endpoint_services = {
    ecr_api        = "com.amazonaws.${var.aws_region}.ecr.api"
    ecr_dkr        = "com.amazonaws.${var.aws_region}.ecr.dkr"
    logs           = "com.amazonaws.${var.aws_region}.logs"
    secretsmanager = "com.amazonaws.${var.aws_region}.secretsmanager"
  }
}

resource "aws_vpc_endpoint" "interface" {
  for_each            = local.interface_endpoint_services
  vpc_id              = aws_vpc.main.id
  service_name        = each.value
  vpc_endpoint_type   = "Interface"
  subnet_ids          = aws_subnet.private[*].id
  security_group_ids  = [aws_security_group.vpc_endpoints.id]
  private_dns_enabled = true

  tags = { Name = "${local.name_prefix}-vpce-${each.key}" }
}