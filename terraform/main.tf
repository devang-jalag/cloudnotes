provider "aws" {
  region = var.aws_region
}

resource "random_id" "suffix" {
  byte_length = 4
}

locals {
  name_prefix        = "cloudnotes"
  frontend_bucket    = "${local.name_prefix}-frontend-${random_id.suffix.hex}"
  attachments_bucket = "${local.name_prefix}-attachments-${random_id.suffix.hex}"
}

# -------------------------
# S3 buckets
# -------------------------
resource "aws_s3_bucket" "frontend" {
  bucket = local.frontend_bucket
}

resource "aws_s3_bucket_public_access_block" "frontend" {
  bucket                  = aws_s3_bucket.frontend.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket" "attachments" {
  bucket = local.attachments_bucket
}

resource "aws_s3_bucket_cors_configuration" "attachments_cors" {
  bucket = aws_s3_bucket.attachments.id

  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["PUT", "POST", "GET", "HEAD"]
    allowed_origins = ["*"] # Allows localhost and your CloudFront domain
    expose_headers  = ["ETag"]
    max_age_seconds = 3000
  }
}

resource "aws_s3_bucket_public_access_block" "attachments" {
  bucket                  = aws_s3_bucket.attachments.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# -------------------------
# DynamoDB
# -------------------------
resource "aws_dynamodb_table" "notes" {
  name         = "${local.name_prefix}_notes"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "user_id"
  range_key    = "note_id"

  attribute {
    name = "user_id"
    type = "S"
  }

  attribute {
    name = "note_id"
    type = "S"
  }
}

resource "aws_dynamodb_table" "versions" {
  name         = "${local.name_prefix}_versions"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "note_id"
  range_key    = "version_ts"

  attribute {
    name = "note_id"
    type = "S"
  }

  attribute {
    name = "version_ts"
    type = "S"
  }
}

resource "aws_dynamodb_table" "shared_notes" {
  name         = "${local.name_prefix}_shared_notes"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "share_token"

  attribute {
    name = "share_token"
    type = "S"
  }

  ttl {
    attribute_name = "expires_at"
    enabled        = true
  }
}

# -------------------------
# Cognito
# -------------------------
resource "aws_cognito_user_pool" "pool" {
  name = "${local.name_prefix}_user_pool"

  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  password_policy {
    minimum_length    = 8
    require_lowercase = true
    require_numbers   = true
    require_symbols   = false
    require_uppercase = true
  }
}

resource "aws_cognito_user_pool_domain" "domain" {
  domain       = "${local.name_prefix}-${random_id.suffix.hex}"
  user_pool_id = aws_cognito_user_pool.pool.id
}

# -------------------------
# Lambda package
# -------------------------
data "archive_file" "lambda_zip" {
  type        = "zip"
  source_dir  = "${path.module}/../backend/src"
  output_path = "${path.module}/../backend/build/lambda.zip"
}

resource "aws_iam_role" "lambda_role" {
  name = "${local.name_prefix}_lambda_role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "lambda_basic_logs" {
  role       = aws_iam_role.lambda_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_policy" "lambda_data_policy" {
  name = "${local.name_prefix}_lambda_data_policy"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem","dynamodb:PutItem","dynamodb:UpdateItem","dynamodb:DeleteItem",
          "dynamodb:Query","dynamodb:Scan","dynamodb:BatchWriteItem"
        ]
        Resource = [
          aws_dynamodb_table.notes.arn,
          aws_dynamodb_table.versions.arn,
          aws_dynamodb_table.shared_notes.arn
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "s3:PutObject","s3:GetObject","s3:DeleteObject"
        ]
        Resource = "${aws_s3_bucket.attachments.arn}/*"
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "lambda_data_attach" {
  role       = aws_iam_role.lambda_role.name
  policy_arn = aws_iam_policy.lambda_data_policy.arn
}

resource "aws_lambda_function" "api" {
  function_name = "${local.name_prefix}_api"
  role          = aws_iam_role.lambda_role.arn

  runtime = "python3.12"
  handler = "app.handler"

  filename         = data.archive_file.lambda_zip.output_path
  source_code_hash = data.archive_file.lambda_zip.output_base64sha256

  environment {
    variables = {
      NOTES_TABLE        = aws_dynamodb_table.notes.name
      VERSIONS_TABLE     = aws_dynamodb_table.versions.name
      SHARED_NOTES_TABLE = aws_dynamodb_table.shared_notes.name
      ATTACHMENTS_BUCKET = aws_s3_bucket.attachments.bucket
      REGION             = var.aws_region
      MAX_VERSIONS       = "10"
    }
  }
}

# -------------------------
# HTTP API Gateway + JWT Authorizer
# -------------------------
resource "aws_apigatewayv2_api" "http_api" {
  name          = "${local.name_prefix}_http_api"
  protocol_type = "HTTP"

  cors_configuration {
    allow_origins = ["*"] # Allows your localhost and future CloudFront domain
    allow_methods = ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
    allow_headers = ["Content-Type", "Authorization"]
    max_age       = 300
  }
}

resource "aws_apigatewayv2_integration" "lambda_integration" {
  api_id                 = aws_apigatewayv2_api.http_api.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.api.arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_authorizer" "jwt" {
  api_id           = aws_apigatewayv2_api.http_api.id
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]
  name             = "${local.name_prefix}_jwt"

  jwt_configuration {
    issuer   = "https://cognito-idp.${var.aws_region}.amazonaws.com/${aws_cognito_user_pool.pool.id}"
    audience = [aws_cognito_user_pool_client.client_final.id]
  }
}

locals {
  protected_routes = [
    "POST /notes",
    "GET /notes",
    "GET /notes/{id}",
    "PUT /notes/{id}",
    "DELETE /notes/{id}",

    "GET /notes/{id}/versions",
    "GET /notes/{id}/versions/{version_ts}",

    "POST /notes/{id}/attachment-url",
    "POST /notes/{id}/share"
  ]
  public_routes = [
    "GET /share/{token}"
  ]
}

resource "aws_apigatewayv2_route" "protected" {
  for_each = toset(local.protected_routes)
  api_id   = aws_apigatewayv2_api.http_api.id
  route_key = each.value
  target    = "integrations/${aws_apigatewayv2_integration.lambda_integration.id}"

  authorization_type = "JWT"
  authorizer_id      = aws_apigatewayv2_authorizer.jwt.id
}

resource "aws_apigatewayv2_route" "public" {
  for_each = toset(local.public_routes)
  api_id   = aws_apigatewayv2_api.http_api.id
  route_key = each.value
  target    = "integrations/${aws_apigatewayv2_integration.lambda_integration.id}"

  authorization_type = "NONE"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.http_api.id
  name        = "$default"
  auto_deploy = true
}

resource "aws_lambda_permission" "apigw_invoke" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http_api.execution_arn}/*/*"
}

# -------------------------
# CloudFront for frontend (OAC)
# -------------------------

resource "aws_cloudfront_origin_access_control" "oac" {
  name                              = "${local.name_prefix}_oac"
  description                       = "OAC for S3 frontend bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_distribution" "cdn" {

  default_root_object = "index.html"

  custom_error_response {
    error_code         = 403
    response_code      = 200
    response_page_path = "/index.html"
  }

  custom_error_response {
    error_code         = 404
    response_code      = 200
    response_page_path = "/index.html"
  }

  enabled             = true

  origin {
    domain_name              = aws_s3_bucket.frontend.bucket_regional_domain_name
    origin_id                = "s3-frontend"
    origin_access_control_id = aws_cloudfront_origin_access_control.oac.id
  }

  default_cache_behavior {
    target_origin_id       = "s3-frontend"
    viewer_protocol_policy = "redirect-to-https"

    allowed_methods  = ["GET", "HEAD", "OPTIONS"]
    cached_methods   = ["GET", "HEAD", "OPTIONS"]

    forwarded_values {
      query_string = true
      cookies { forward = "none" }
    }
  }

  restrictions {
    geo_restriction { restriction_type = "none" }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}

# Allow CloudFront to read from the frontend bucket
resource "aws_s3_bucket_policy" "frontend_policy" {
  bucket = aws_s3_bucket.frontend.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "AllowCloudFrontRead"
      Effect   = "Allow"
      Principal = { Service = "cloudfront.amazonaws.com" }
      Action   = ["s3:GetObject"]
      Resource = "${aws_s3_bucket.frontend.arn}/*"
      Condition = {
        StringEquals = {
          "AWS:SourceArn" = aws_cloudfront_distribution.cdn.arn
        }
      }
    }]
  })
}

# Now that CloudFront exists, set proper callback/logout URLs for Cognito client
resource "aws_cognito_user_pool_client" "client_final" {
  name         = "${local.name_prefix}_client"
  user_pool_id = aws_cognito_user_pool.pool.id

  generate_secret = false

  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code", "implicit"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  supported_identity_providers         = ["COGNITO"]

  callback_urls = [
    "https://${aws_cloudfront_distribution.cdn.domain_name}/",
    "http://localhost:5173/"
  ]
  logout_urls   = [
    "https://${aws_cloudfront_distribution.cdn.domain_name}/",
    "http://localhost:5173/"
  ]
}