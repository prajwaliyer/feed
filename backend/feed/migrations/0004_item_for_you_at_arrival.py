from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('feed', '0003_item_engagement_checked_at_item_promoted_at'),
    ]

    operations = [
        migrations.AddField(
            model_name='item',
            name='for_you_at_arrival',
            field=models.BooleanField(default=False),
        ),
    ]
