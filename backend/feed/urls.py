from django.urls import path

from . import views

urlpatterns = [
    path("login", views.login),
    path("logout", views.logout),
    path("auth/check", views.auth_check),
    path("items", views.items_list),
    path("items/<int:item_id>", views.item_detail),
    path("stories", views.stories),
    path("sources", views.sources_view),
    path("fetch", views.fetch_feeds),
    path("last-fetch", views.last_fetch),
    path("health", views.health),
    path("proxy", views.proxy),
    path("link-preview", views.link_preview),
]
