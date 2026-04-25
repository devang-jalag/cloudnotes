output "api_base_url" {
  value = aws_apigatewayv2_api.http_api.api_endpoint
}

output "cloudfront_url" {
  value = "https://${aws_cloudfront_distribution.cdn.domain_name}"
}

output "cognito_domain" {
  value = "https://${aws_cognito_user_pool_domain.domain.domain}.auth.${var.aws_region}.amazoncognito.com"
}

output "cognito_user_pool_id" {
  value = aws_cognito_user_pool.pool.id
}

output "cognito_client_id" {
  value = aws_cognito_user_pool_client.client_final.id
}

output "attachments_bucket" {
  value = aws_s3_bucket.attachments.bucket
}

output "frontend_bucket" {
  value = aws_s3_bucket.frontend.bucket
}