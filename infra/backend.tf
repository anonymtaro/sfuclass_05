/**
 * infra/backend.tf [NEW] S3 state + DynamoDB lock
 * Deliberately empty of literal values — every environment supplies its own
 * bucket/key/table via `terraform init -backend-config=envs/<env>/backend.hcl`,
 * so dev, staging and prod can never accidentally share state.
 *
 * One-time bootstrap (before first `terraform init` in any environment):
 *   aws s3api create-bucket --bucket classroom-platform-tfstate --region eu-central-1
 *   aws s3api put-bucket-versioning --bucket classroom-platform-tfstate \
 *     --versioning-configuration Status=Enabled
 *   aws dynamodb create-table --table-name classroom-platform-tf-locks \
 *     --attribute-definitions AttributeName=LockID,AttributeType=S \
 *     --key-schema AttributeName=LockID,KeyType=HASH \
 *     --billing-mode PAY_PER_REQUEST
 */

terraform {
  backend "s3" {
    encrypt = true
    # bucket, key, region, dynamodb_table -> injected per environment
  }
}