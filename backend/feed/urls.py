from django.urls import path

from . import views

urlpatterns = [
    path("items", views.items_list),
    path("items/<int:item_id>", views.item_detail),
    path("sources", views.sources_view),
    path("fetch", views.fetch_feeds),
    path("last-fetch", views.last_fetch),
    path("health", views.health),
    path("proxy", views.proxy),
    path("link-preview", views.link_preview),
]
