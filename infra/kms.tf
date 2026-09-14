/**
 * infra/kms.tf [NEW] CMKs for RDS · S3 · logs · secrets
 * One CMK per concern rather than the AWS-managed default key, so each can be
 * rotated and access-controlled independently (least privilege, section 12).
 */

resource "aws_kms_key" "rds" {
  description             = "CMK for RDS PostgreSQL storage + managed master password"
  deletion_window_in_days = var.kms_deletion_window
  enable_key_rotation     = true
  tags                    = { Name = "${local.name_prefix}-kms-rds" }
}
resource "aws_kms_alias" "rds" {
  name          = "alias/${local.name_prefix}-rds"
  target_key_id = aws_kms_key.rds.key_id
}

resource "aws_kms_key" "s3" {
  description             = "CMK for media raw/quarantine/delivery and SPA build buckets"
  deletion_window_in_days = var.kms_deletion_window
  enable_key_rotation     = true
  tags                    = { Name = "${local.name_prefix}-kms-s3" }
}
resource "aws_kms_alias" "s3" {
  name          = "alias/${local.name_prefix}-s3"
  target_key_id = aws_kms_key.s3.key_id
}

resource "aws_kms_key" "logs" {
  description             = "CMK for CloudWatch Logs (ECS api/realtime/worker/sfu)"
  deletion_window_in_days = var.kms_deletion_window
  enable_key_rotation     = true
  tags                    = { Name = "${local.name_prefix}-kms-logs" }
}
resource "aws_kms_alias" "logs" {
  name          = "alias/${local.name_prefix}-logs"
  target_key_id = aws_kms_key.logs.key_id
}

resource "aws_kms_key" "secrets" {
  description             = "CMK for Secrets Manager (JWT keys, APNs/FCM credentials)"
  deletion_window_in_days = var.kms_deletion_window
  enable_key_rotation     = true
  tags                    = { Name = "${local.name_prefix}-kms-secrets" }
}
resource "aws_kms_alias" "secrets" {
  name          = "alias/${local.name_prefix}-secrets"
  target_key_id = aws_kms_key.secrets.key_id
}