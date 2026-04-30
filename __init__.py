from flask import Blueprint, render_template
from sqlalchemy import event

from CTFd.models import Solves, db
from CTFd.utils.events import ServerSentEvents

from CTFd.plugins import (
    register_plugin_script,
    register_plugin_stylesheet,
    register_user_page_menu_bar,
)


def check_first_blood(mapper, connection, target):
    solve_count = connection.scalar(
        db.select(db.func.count(Solves.id)).where(Solves.challenge_id == target.challenge_id)
    )

    if solve_count == 1:
        payload = {
            "challenge_id": target.challenge_id,
            "account_id": target.account_id,
        }
        ServerSentEvents.publish(data=payload, type="livemap_fb")


def load(app):
    blueprint = Blueprint(
        "ctfd_livemap",
        __name__,
        template_folder="templates",
        static_folder="static",
        static_url_path="/plugins/live-attack-map/static",
    )

    @blueprint.route("/livemap")
    def livemap():
        return render_template("livemap.html", title="Live Map")

    app.register_blueprint(blueprint)

    register_plugin_stylesheet("plugins/live-attack-map/static/livemap.css")
    register_plugin_script("plugins/live-attack-map/static/livemap.js")

    # CTFd resolves plugin menu items through the generic page router.
    # Using "livemap" here still generates "/livemap", which the blueprint handles.
    register_user_page_menu_bar("Live Map", "livemap")

    event.listen(Solves, "after_insert", check_first_blood)
