/**
 * infra/backup.tf [NEW] AWS Backup plans, cross-region copy
 * Matches section 9.2: RDS nightly snapshot copied to a second region,
 * quarterly restore drill target (ops/scripts/verify-backup.sh restores
 * from this vault, not from the raw RDS automated backup).
 */

resource "aws_backup_vault" "main" {
  name        = "${local.name_prefix}-backup-vault"
  kms_key_arn = aws_kms_key.rds.arn
}

resource "aws_kms_key" "rds_dr" {
  provider                = aws.dr_region
  description             = "CMK for the cross-region RDS backup vault"
  deletion_window_in_days = var.kms_deletion_window
  enable_key_rotation     = true
  tags                    = { Name = "${local.name_prefix}-kms-rds-dr" }
}

resource "aws_backup_vault" "cross_region" {
  provider    = aws.dr_region
  name        = "${local.name_prefix}-backup-vault-dr"
  kms_key_arn = aws_kms_key.rds_dr.arn
}

resource "aws_backup_plan" "main" {
  name = "${local.name_prefix}-backup-plan"

  rule {
    rule_name         = "nightly"
    target_vault_name = aws_backup_vault.main.name
    schedule          = "cron(0 3 * * ? *)" # 03:00 UTC daily

    lifecycle {
      delete_after = var.environment == "prod" ? 90 : 30
    }

    copy_action {
      destination_vault_arn = aws_backup_vault.cross_region.arn

      lifecycle {
        delete_after = var.environment == "prod" ? 90 : 30
      }
    }
  }

  tags = { Name = "${local.name_prefix}-backup-plan" }
}

resource "aws_iam_role" "backup" {
  name = "${local.name_prefix}-backup-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "backup.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "backup" {
  role       = aws_iam_role.backup.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup"
}

resource "aws_iam_role_policy_attachment" "backup_restore" {
  role       = aws_iam_role.backup.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForRestores"
}

# Tag-based selection: anything tagged Backup=true is covered without
# listing every resource ARN by hand as the platform grows.
resource "aws_backup_selection" "tagged" {
  name         = "${local.name_prefix}-backup-selection"
  iam_role_arn = aws_iam_role.backup.arn
  plan_id      = aws_backup_plan.main.id

  resources = [aws_db_instance.primary.arn]

  condition {
    string_equals {
      key   = "aws:ResourceTag/Backup"
      value = "true"
    }
  }
}