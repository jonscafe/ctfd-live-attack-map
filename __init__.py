from flask import Blueprint, render_template
from sqlalchemy import event
from sqlalchemy.orm import object_session

from CTFd.models import Solves, db
from CTFd.utils.events import ServerSentEvents

PENDING_FIRST_BLOODS_KEY = "livemap_pending_first_bloods"

from CTFd.plugins import (
    register_plugin_script,
    register_plugin_stylesheet,
    register_user_page_menu_bar,
)


def check_first_blood(mapper, connection, target):
    session = object_session(target)
    if session is None or target.challenge_id is None or target.account_id is None:
        return

    pending = session.info.setdefault(PENDING_FIRST_BLOODS_KEY, {})
    account_ids = pending.setdefault(target.challenge_id, set())
    account_ids.add(int(target.account_id))


def publish_first_bloods(session):
    pending = session.info.pop(PENDING_FIRST_BLOODS_KEY, {})
    if not pending:
        return

    for challenge_id, account_ids in pending.items():
        first_solve = session.execute(
            db.select(Solves.account_id)
            .where(Solves.challenge_id == challenge_id)
            .order_by(Solves.date, Solves.id)
            .limit(1)
        ).first()
        if not first_solve:
            continue

        first_account_id = first_solve[0]
        if first_account_id in account_ids:
            payload = {
                "challenge_id": challenge_id,
                "account_id": first_account_id,
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
    event.listen(db.session, "after_commit", publish_first_bloods)
