/**
 * infra/data.tf [EXT] + read replica · OpenSearch (F2,F3,F6)
 * RDS PostgreSQL Multi-AZ, ElastiCache Redis with automatic failover, and
 * OpenSearch for chat/community/course search - all private-subnets-only,
 * matching security-groups.tf's rds/redis/opensearch groups.
 */

resource "aws_db_subnet_group" "main" {
  name       = "${local.name_prefix}-db-subnets"
  subnet_ids = aws_subnet.private[*].id

  tags = { Name = "${local.name_prefix}-db-subnets" }
}

resource "aws_db_instance" "primary" {
  identifier     = "${local.name_prefix}-pg"
  engine         = "postgres"
  engine_version = var.db_engine_version
  instance_class = var.db_instance_class

  allocated_storage = var.db_allocated_storage
  storage_encrypted = true

  db_name  = var.db_name
  username = var.db_username

  manage_master_user_password        = true # credential lives in Secrets Manager, never in state
  manage_master_user_password_kms_key_id = aws_kms_key.secrets.arn
  kms_key_id                             = aws_kms_key.rds.arn

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]

  multi_az                = var.environment == "prod"
  backup_retention_period = 7
  deletion_protection     = var.environment == "prod"
  skip_final_snapshot     = var.environment != "prod"

  tags = { Name = "${local.name_prefix}-pg" }
}

# Read replica takes feed, search-fallback and reporting queries; writes never go to it.
resource "aws_db_instance" "read_replica" {
  count = var.create_read_replica ? 1 : 0

  identifier          = "${local.name_prefix}-pg-replica"
  replicate_source_db = aws_db_instance.primary.identifier
  instance_class      = var.db_instance_class

  vpc_security_group_ids = [aws_security_group.rds.id]
  skip_final_snapshot    = true

  tags = { Name = "${local.name_prefix}-pg-replica" }
}

resource "aws_elasticache_subnet_group" "main" {
  name       = "${local.name_prefix}-redis-subnets"
  subnet_ids = aws_subnet.private[*].id
}

# Four uses on this one cluster: entitlement cache, seat-reservation Lua,
# presence/unread counters, BullMQ queues (per-concern key prefixes, not
# separate clusters - see db/redis.js).
resource "aws_elasticache_replication_group" "main" {
  replication_group_id = "${local.name_prefix}-redis"
  description           = "Shared Redis: entitlements, presence, unread counters, BullMQ"

  engine         = "redis"
  node_type      = var.redis_node_type
  num_cache_clusters = var.environment == "prod" ? 2 : 1

  automatic_failover_enabled = var.environment == "prod"
  multi_az_enabled           = var.environment == "prod"

  subnet_group_name = aws_elasticache_subnet_group.main.name
  security_group_ids = [aws_security_group.redis.id]

  at_rest_encryption_enabled = true
  transit_encryption_enabled = true

  snapshot_retention_limit = 1 # daily snapshot, reconstructible cache/queue state

  tags = { Name = "${local.name_prefix}-redis" }
}

# One cluster, three index families (chat, community, course search).
resource "aws_opensearch_domain" "main" {
  domain_name    = "${local.name_prefix}-search"
  engine_version = "OpenSearch_2.15"

  cluster_config {
    instance_type  = var.opensearch_instance_type
    instance_count = var.environment == "prod" ? 3 : 1
  }

  ebs_options {
    ebs_enabled = true
    volume_size = var.opensearch_volume_size_gb
    volume_type = "gp3"
  }

  vpc_options {
    subnet_ids         = [aws_subnet.private[0].id]
    security_group_ids = [aws_security_group.opensearch.id]
  }

  encrypt_at_rest {
    enabled = true
  }

  node_to_node_encryption {
    enabled = true
  }

  domain_endpoint_options {
    enforce_https = true
  }

  tags = { Name = "${local.name_prefix}-search" }
}