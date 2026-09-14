/**
 * infra/ecr.tf [NEW] repos + lifecycle + scan on push
 * One repo per Dockerfile (server/Dockerfile.api, .worker, .sfu). Their
 * repository_url is what var.api_image / worker_image / sfu_image ultimately
 * point at (CI appends :<commit-sha> - see .github/workflows/build-images.yml).
 */

resource "aws_ecr_repository" "this" {
  for_each             = toset(["api", "worker", "sfu"])
  name                 = "${local.name_prefix}-${each.key}"
  image_tag_mutability = "IMMUTABLE"

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "KMS"
    kms_key         = aws_kms_key.s3.arn # reuse the platform's generic storage CMK
  }

  tags = { Name = "${local.name_prefix}-ecr-${each.key}" }
}

resource "aws_ecr_lifecycle_policy" "this" {
  for_each   = aws_ecr_repository.this
  repository = each.value.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the most recent 20 images, expire the rest"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 20
      }
      action = { type = "expire" }
    }]
  })
}