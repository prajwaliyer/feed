from django.db import models


class Source(models.Model):
    type = models.CharField(max_length=50, default="twitter_user")
    name = models.CharField(max_length=255)
    url = models.URLField(max_length=500)
    icon_url = models.URLField(max_length=500, blank=True, null=True)
    category = models.CharField(max_length=100, blank=True, null=True)
    is_important = models.BooleanField(default=False)
    priority = models.CharField(max_length=20, blank=True, null=True)
    follower_count = models.IntegerField(blank=True, null=True)
    custom_multiplier = models.CharField(max_length=20, blank=True, null=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "feed_source"

    def to_dict(self):
        return {
            "id": self.id,
            "type": self.type,
            "name": self.name,
            "url": self.url,
            "iconUrl": self.icon_url,
            "category": self.category,
            "isImportant": self.is_important,
            "priority": self.priority,
            "followerCount": self.follower_count,
            "customMultiplier": self.custom_multiplier,
            "createdAt": self.created_at.isoformat() if self.created_at else None,
            "updatedAt": self.updated_at.isoformat() if self.updated_at else None,
        }


class Item(models.Model):
    source = models.ForeignKey(Source, on_delete=models.CASCADE, related_name="items")
    guid = models.CharField(max_length=500, unique=True)
    title = models.TextField(blank=True, null=True)
    content = models.TextField(blank=True, null=True)
    url = models.URLField(max_length=500, blank=True, null=True)
    author = models.CharField(max_length=255, blank=True, null=True)
    image_url = models.URLField(max_length=500, blank=True, null=True)
    published_at = models.DateTimeField(blank=True, null=True)
    fetched_at = models.DateTimeField(auto_now_add=True)
    is_read = models.BooleanField(default=False)
    is_starred = models.BooleanField(default=False)
    like_count = models.IntegerField(blank=True, null=True)
    reply_count = models.IntegerField(blank=True, null=True)

    class Meta:
        db_table = "feed_item"
        indexes = [
            models.Index(fields=["source"]),
            models.Index(fields=["-published_at"]),
            models.Index(fields=["is_starred"]),
        ]

    def to_dict(self, source=None):
        src = source or self.source
        return {
            "id": self.id,
            "sourceId": self.source_id,
            "guid": self.guid,
            "title": self.title,
            "content": self.content,
            "url": self.url,
            "author": self.author,
            "imageUrl": self.image_url,
            "publishedAt": self.published_at.isoformat() if self.published_at else None,
            "isRead": self.is_read,
            "isStarred": self.is_starred,
            "likeCount": self.like_count,
            "replyCount": self.reply_count,
            "sourceName": src.name if src else None,
            "sourceIcon": src.icon_url if src else None,
        }


class Setting(models.Model):
    key = models.CharField(max_length=255, primary_key=True)
    value = models.TextField()

    class Meta:
        db_table = "feed_setting"
