import json
import os
import uuid
import time
from datetime import datetime, timezone

import boto3
from boto3.dynamodb.conditions import Key
from botocore.config import Config

NOTES_TABLE = os.environ["NOTES_TABLE"]
VERSIONS_TABLE = os.environ["VERSIONS_TABLE"]
SHARED_NOTES_TABLE = os.environ["SHARED_NOTES_TABLE"]
ATTACHMENTS_BUCKET = os.environ["ATTACHMENTS_BUCKET"]

ddb = boto3.resource("dynamodb")
s3 = boto3.client("s3", config=Config(signature_version="s3v4", region_name=os.environ.get("REGION", "us-east-1")))

notes_tbl = ddb.Table(NOTES_TABLE)
versions_tbl = ddb.Table(VERSIONS_TABLE)
shared_tbl = ddb.Table(SHARED_NOTES_TABLE)

def now_iso():
    return datetime.now(timezone.utc).isoformat()

def response(status, body):
    return {
        "statusCode": status,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*" # Required for frontend testing
        },
        "body": json.dumps(body),
    }

def get_user_id(event):
    try:
        return event["requestContext"]["authorizer"]["jwt"]["claims"]["sub"]
    except KeyError:
        return None

def handler(event, context):
    route = event.get("routeKey")
    print("ROUTE:", route)

    if route == "POST /notes":
        return create_note(event)
    if route == "GET /notes":
        return list_notes(event)
    if route == "GET /notes/{id}":
        return get_note(event)
    if route == "PUT /notes/{id}":
        return update_note(event)
    if route == "DELETE /notes/{id}":
        return delete_note(event)
    if route == "GET /notes/{id}/versions":
        return list_versions(event)
    if route == "GET /notes/{id}/versions/{version_ts}":
        return get_version(event)
    if route == "POST /notes/{id}/attachment-url":
        return generate_attachment_url(event)
    if route == "POST /notes/{id}/share":
        return create_share_token(event)
    if route == "GET /share/{token}":
        return get_shared_note(event)

    return response(404, {"message": "Not Found"})

# --- EXISTING CRUD FUNCTIONS (Unchanged logic, just keeping it intact) ---

def create_note(event):
    user_id = get_user_id(event)
    body = json.loads(event.get("body") or "{}")
    title = body.get("title")
    content = body.get("content", "")
    tags = body.get("tags", [])

    if not title:
        return response(400, {"message": "Title is required"})

    note_id = str(uuid.uuid4())
    ts = now_iso()

    item = {
        "user_id": user_id,
        "note_id": note_id,
        "title": title,
        "content": content,
        "tags": tags,
        "attachments": [], # Initialize empty attachments list
        "created_at": ts,
        "updated_at": ts,
        "is_deleted": False,
    }
    notes_tbl.put_item(Item=item)
    return response(201, item)

def list_notes(event):
    user_id = get_user_id(event)
    result = notes_tbl.query(KeyConditionExpression=Key("user_id").eq(user_id))
    items = [i for i in result.get("Items", []) if not i.get("is_deleted")]
    return response(200, items)

def get_note(event):
    user_id = get_user_id(event)
    note_id = event["pathParameters"]["id"]
    result = notes_tbl.get_item(Key={"user_id": user_id, "note_id": note_id})
    item = result.get("Item")
    if not item or item.get("is_deleted"):
        return response(404, {"message": "Note not found"})
    return response(200, item)

def update_note(event):
    user_id = get_user_id(event)
    note_id = event["pathParameters"]["id"]
    body = json.loads(event.get("body") or "{}")
    
    existing = notes_tbl.get_item(Key={"user_id": user_id, "note_id": note_id}).get("Item")
    if not existing or existing.get("is_deleted"):
        return response(404, {"message": "Note not found"})

    version_ts = now_iso()
    versions_tbl.put_item(
        Item={
            "note_id": note_id,
            "version_ts": version_ts,
            "user_id": user_id,
            "title": existing.get("title", ""),
            "content": existing.get("content", ""),
            "tags": existing.get("tags", []),
            "attachments": existing.get("attachments", []),
            "created_at": existing.get("created_at"),
            "updated_at": existing.get("updated_at"),
        }
    )

    update_parts = []
    values = {}
    if "title" in body:
        update_parts.append("title = :t")
        values[":t"] = body["title"]
    if "content" in body:
        update_parts.append("content = :c")
        values[":c"] = body["content"]
    if "tags" in body:
        update_parts.append("tags = :g")
        values[":g"] = body["tags"]

    update_parts.append("updated_at = :u")
    values[":u"] = version_ts

    notes_tbl.update_item(
        Key={"user_id": user_id, "note_id": note_id},
        UpdateExpression="SET " + ", ".join(update_parts),
        ExpressionAttributeValues=values,
    )
    return response(200, {"message": "Note updated", "saved_version_ts": version_ts})

def delete_note(event):
    user_id = get_user_id(event)
    note_id = event["pathParameters"]["id"]
    existing = notes_tbl.get_item(Key={"user_id": user_id, "note_id": note_id}).get("Item")
    if not existing or existing.get("is_deleted"):
        return response(404, {"message": "Note not found"})

    notes_tbl.update_item(
        Key={"user_id": user_id, "note_id": note_id},
        UpdateExpression="SET is_deleted = :d, updated_at = :u",
        ExpressionAttributeValues={":d": True, ":u": now_iso()},
    )
    return response(200, {"message": "Note deleted"})

def list_versions(event):
    user_id = get_user_id(event)
    note_id = event["pathParameters"]["id"]
    existing = notes_tbl.get_item(Key={"user_id": user_id, "note_id": note_id}).get("Item")
    if not existing:
        return response(404, {"message": "Note not found"})

    result = versions_tbl.query(
        KeyConditionExpression=Key("note_id").eq(note_id),
        ScanIndexForward=False
    )
    summary = [{"note_id": v["note_id"], "version_ts": v["version_ts"], "title": v.get("title", ""), "updated_at": v.get("updated_at")} for v in result.get("Items", [])]
    return response(200, summary)

def get_version(event):
    user_id = get_user_id(event)
    note_id = event["pathParameters"]["id"]
    version_ts = event["pathParameters"]["version_ts"]
    existing = notes_tbl.get_item(Key={"user_id": user_id, "note_id": note_id}).get("Item")
    if not existing:
        return response(404, {"message": "Note not found"})

    result = versions_tbl.get_item(Key={"note_id": note_id, "version_ts": version_ts})
    item = result.get("Item")
    if not item or item.get("user_id") != user_id:
        return response(404, {"message": "Version not found"})
    return response(200, item)

# --- THE FIX: Attachment Metadata is now saved ---

def generate_attachment_url(event):
    user_id = get_user_id(event)
    note_id = event["pathParameters"]["id"]
    body = json.loads(event.get("body") or "{}")
    filename = body.get("filename")
    content_type = body.get("content_type")

    if not filename or not content_type:
        return response(400, {"message": "filename and content_type required"})
    if not content_type.startswith("image/"):
        return response(400, {"message": "Only image uploads allowed"})

    existing = notes_tbl.get_item(Key={"user_id": user_id, "note_id": note_id}).get("Item")
    if not existing or existing.get("is_deleted"):
        return response(404, {"message": "Note not found"})

    object_key = f"{user_id}/{note_id}/{uuid.uuid4()}_{filename}"

    # Generate the upload URL
    presigned_url = s3.generate_presigned_url(
        ClientMethod="put_object",
        Params={"Bucket": ATTACHMENTS_BUCKET, "Key": object_key, "ContentType": content_type},
        ExpiresIn=300,
    )

    # THE FIX: Append the new object_key to the note's attachments list
    notes_tbl.update_item(
        Key={"user_id": user_id, "note_id": note_id},
        UpdateExpression="SET attachments = list_append(if_not_exists(attachments, :empty_list), :new_attachment)",
        ExpressionAttributeValues={
            ":empty_list": [],
            ":new_attachment": [object_key]
        }
    )

    return response(200, {"upload_url": presigned_url, "object_key": object_key, "expires_in": 300})

# --- NEW FEATURES: Share functionality ---

def create_share_token(event):
    user_id = get_user_id(event)
    note_id = event["pathParameters"]["id"]
    
    existing = notes_tbl.get_item(Key={"user_id": user_id, "note_id": note_id}).get("Item")
    if not existing or existing.get("is_deleted"):
        return response(404, {"message": "Note not found"})

    share_token = str(uuid.uuid4().hex) # Clean URL-friendly token
    expires_at = int(time.time()) + (7 * 24 * 60 * 60) # 7 days TTL

    shared_tbl.put_item(
        Item={
            "share_token": share_token,
            "note_id": note_id,
            "user_id": user_id,
            "expires_at": expires_at
        }
    )

    # Assuming API Gateway domain is known or passed, otherwise return relative
    return response(200, {"share_token": share_token, "expires_in_days": 7})

def get_shared_note(event):
    token = event["pathParameters"]["token"]
    
    # 1. Validate Token
    share_record = shared_tbl.get_item(Key={"share_token": token}).get("Item")
    if not share_record:
        return response(404, {"message": "Share link invalid or expired"})
        
    # Check TTL manually just in case DynamoDB hasn't swept it yet
    if int(time.time()) > share_record.get("expires_at", 0):
        return response(404, {"message": "Share link has expired"})

    # 2. Fetch Note
    note_id = share_record["note_id"]
    user_id = share_record["user_id"]
    note = notes_tbl.get_item(Key={"user_id": user_id, "note_id": note_id}).get("Item")
    
    if not note or note.get("is_deleted"):
        return response(404, {"message": "Note no longer exists"})

    # 3. Generate GET URLs for attachments so the public viewer can see images
    attachment_urls = []
    for key in note.get("attachments", []):
        url = s3.generate_presigned_url(
            ClientMethod="get_object",
            Params={"Bucket": ATTACHMENTS_BUCKET, "Key": key},
            ExpiresIn=3600 # 1 hour viewing time
        )
        attachment_urls.append({"object_key": key, "url": url})

    # Return safe public payload
    return response(200, {
        "title": note.get("title"),
        "content": note.get("content"),
        "tags": note.get("tags"),
        "created_at": note.get("created_at"),
        "updated_at": note.get("updated_at"),
        "attachments": attachment_urls
    })