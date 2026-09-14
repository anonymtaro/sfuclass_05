/**
 * infra/pipeline.tf [EXT] + mobile EAS build stage (F5)
 * .github/workflows/deploy-mobile.yml runs `eas build` and needs the Expo
 * access token; that token lives here, not in a GitHub secret, so rotating
 * it doesn't require touching repo settings.
 */

resource "aws_secretsmanager_secret" "expo_token" {
  name       = "${local.name_prefix}-expo-token"
  kms_key_id = aws_kms_key.secrets.arn
}

resource "aws_secretsmanager_secret_version" "expo_token" {
  secret_id     = aws_secretsmanager_secret.expo_token.id
  secret_string = jsonencode({ EXPO_TOKEN = "REPLACE_AFTER_APPLY" })

  lifecycle {
    ignore_changes = [secret_string]
  }
}

resource "aws_iam_role_policy" "github_actions_mobile_secrets" {
  name = "${local.name_prefix}-github-mobile-secrets"
  role = aws_iam_role.github_actions_deploy.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = aws_secretsmanager_secret.expo_token.arn
    }]
  })
}

# Records the last successfully promoted image digest per service, so
# deploy-api.yml / deploy-sfu.yml can diff against it before triggering a
# rolling deployment, and rollback.md can read it back during an incident.
resource "aws_ssm_parameter" "last_deployed_digest" {
  for_each = toset(["api", "worker", "sfu"])
  name     = "/${local.name_prefix}/deploy/${each.key}/last-digest"
  type     = "String"
  value    = "unset"

  lifecycle {
    ignore_changes = [value]
  }
}