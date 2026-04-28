from flask import Blueprint, render_template

from CTFd.plugins import (
    register_plugin_script,
    register_plugin_stylesheet,
    register_user_page_menu_bar,
)


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
