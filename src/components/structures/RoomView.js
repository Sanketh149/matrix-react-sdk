/*
Copyright 2015 OpenMarket Ltd

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

// TODO: This component is enormous! There's several things which could stand-alone:
//  - Aux component
//  - Search results component
//  - Drag and drop
//  - File uploading - uploadFile()
//  - Timeline component (alllll the logic in getEventTiles())

var React = require("react");
var ReactDOM = require("react-dom");
var q = require("q");
var classNames = require("classnames");
var Matrix = require("matrix-js-sdk");

var MatrixClientPeg = require("../../MatrixClientPeg");
var ContentMessages = require("../../ContentMessages");
var WhoIsTyping = require("../../WhoIsTyping");
var Modal = require("../../Modal");
var sdk = require('../../index');
var CallHandler = require('../../CallHandler');
var TabComplete = require("../../TabComplete");
var MemberEntry = require("../../TabCompleteEntries").MemberEntry;
var Resend = require("../../Resend");
var dis = require("../../dispatcher");

var PAGINATE_SIZE = 20;
var INITIAL_SIZE = 20;

var DEBUG_SCROLL = false;

module.exports = React.createClass({
    displayName: 'RoomView',
    propTypes: {
        ConferenceHandler: React.PropTypes.any
    },

    /* properties in RoomView objects include:
     *
     * eventNodes: a map from event id to DOM node representing that event
     */
    getInitialState: function() {
        var room = this.props.roomId ? MatrixClientPeg.get().getRoom(this.props.roomId) : null;
        return {
            room: room,
            messageCap: INITIAL_SIZE,
            editingRoomSettings: false,
            uploadingRoomSettings: false,
            numUnreadMessages: 0,
            draggingFile: false,
            searching: false,
            searchResults: null,
            syncState: MatrixClientPeg.get().getSyncState(),
            hasUnsentMessages: this._hasUnsentMessages(room),
            callState: null,
        }
    },

    componentWillMount: function() {
        this.dispatcherRef = dis.register(this.onAction);
        MatrixClientPeg.get().on("Room.timeline", this.onRoomTimeline);
        MatrixClientPeg.get().on("Room.name", this.onRoomName);
        MatrixClientPeg.get().on("Room.receipt", this.onRoomReceipt);
        MatrixClientPeg.get().on("RoomMember.typing", this.onRoomMemberTyping);
        MatrixClientPeg.get().on("RoomState.members", this.onRoomStateMember);
        MatrixClientPeg.get().on("sync", this.onSyncStateChange);
        // xchat-style tab complete, add a colon if tab
        // completing at the start of the text
        this.tabComplete = new TabComplete({
            startingWordSuffix: ": ",
            wordSuffix: " ",
            allowLooping: false,
            autoEnterTabComplete: true,
            onClickCompletes: true,
            onStateChange: (isCompleting) => {
                this.forceUpdate();
            }
        });
    },

    componentWillUnmount: function() {
        if (this.refs.messagePanel) {
            // disconnect the D&D event listeners from the message panel. This
            // is really just for hygiene - the messagePanel is going to be
            // deleted anyway, so it doesn't matter if the event listeners
            // don't get cleaned up.
            var messagePanel = ReactDOM.findDOMNode(this.refs.messagePanel);
            messagePanel.removeEventListener('drop', this.onDrop);
            messagePanel.removeEventListener('dragover', this.onDragOver);
            messagePanel.removeEventListener('dragleave', this.onDragLeaveOrEnd);
            messagePanel.removeEventListener('dragend', this.onDragLeaveOrEnd);
        }
        dis.unregister(this.dispatcherRef);
        if (MatrixClientPeg.get()) {
            MatrixClientPeg.get().removeListener("Room.timeline", this.onRoomTimeline);
            MatrixClientPeg.get().removeListener("Room.name", this.onRoomName);
            MatrixClientPeg.get().removeListener("Room.receipt", this.onRoomReceipt);
            MatrixClientPeg.get().removeListener("RoomMember.typing", this.onRoomMemberTyping);
            MatrixClientPeg.get().removeListener("RoomState.members", this.onRoomStateMember);
            MatrixClientPeg.get().removeListener("sync", this.onSyncStateChange);
        }

        window.removeEventListener('resize', this.onResize);        
    },

    onAction: function(payload) {
        switch (payload.action) {
            case 'message_send_failed':
            case 'message_sent':
                this.setState({
                    hasUnsentMessages: this._hasUnsentMessages(this.state.room)
                });
            case 'message_resend_started':
                this.setState({
                    room: MatrixClientPeg.get().getRoom(this.props.roomId)
                });
                this.forceUpdate();
                break;
            case 'notifier_enabled':
            case 'upload_failed':
            case 'upload_started':
            case 'upload_finished':
                this.forceUpdate();
                break;
            case 'call_state':
                // don't filter out payloads for room IDs other than props.room because
                // we may be interested in the conf 1:1 room

                if (!payload.room_id) {
                    return;
                }

                var call = CallHandler.getCallForRoom(payload.room_id);
                var callState;

                if (call) {
                    // Call state has changed so we may be loading video elements
                    // which will obscure the message log.
                    // scroll to bottom
                    this.scrollToBottom();
                    callState = call.call_state;
                }
                else {
                    callState = "ended";
                }

                // possibly remove the conf call notification if we're now in
                // the conf
                this._updateConfCallNotification();

                this.setState({
                    callState: callState
                });

                break;
            case 'user_activity':
                this.sendReadReceipt();
                break;
        }
    },

    onSyncStateChange: function(state, prevState) {
        if (state === "SYNCING" && prevState === "SYNCING") {
            return;
        }
        this.setState({
            syncState: state
        });
    },

    // MatrixRoom still showing the messages from the old room?
    // Set the key to the room_id. Sadly you can no longer get at
    // the key from inside the component, or we'd check this in code.
    /*componentWillReceiveProps: function(props) {
    },*/

    onRoomTimeline: function(ev, room, toStartOfTimeline) {
        if (!this.isMounted()) return;

        // ignore anything that comes in whilst paginating: we get one
        // event for each new matrix event so this would cause a huge
        // number of UI updates. Just update the UI when the paginate
        // call returns.
        if (this.state.paginating) return;

        // no point handling anything while we're waiting for the join to finish:
        // we'll only be showing a spinner.
        if (this.state.joining) return;
        if (room.roomId != this.props.roomId) return;

        var currentUnread = this.state.numUnreadMessages;
        if (!toStartOfTimeline &&
                (ev.getSender() !== MatrixClientPeg.get().credentials.userId)) {
            // update unread count when scrolled up
            if (!this.state.searchResults && this.refs.messagePanel && this.refs.messagePanel.isAtBottom()) {
                currentUnread = 0;
            }
            else {
                currentUnread += 1;
            }
        }

        this.setState({
            room: MatrixClientPeg.get().getRoom(this.props.roomId),
            numUnreadMessages: currentUnread
        });
    },

    onRoomName: function(room) {
        if (room.roomId == this.props.roomId) {
            this.setState({
                room: room
            });
        }
    },

    onRoomReceipt: function(receiptEvent, room) {
        if (room.roomId == this.props.roomId) {
            this.forceUpdate();
        }
    },

    onRoomMemberTyping: function(ev, member) {
        this.forceUpdate();
    },

    onRoomStateMember: function(ev, state, member) {
        if (member.roomId === this.props.roomId) {
            // a member state changed in this room, refresh the tab complete list
            this._updateTabCompleteList(this.state.room);
        }

        if (!this.props.ConferenceHandler) {
            return;
        }
        if (member.roomId !== this.props.roomId ||
                member.userId !== this.props.ConferenceHandler.getConferenceUserIdForRoom(member.roomId)) {
            return;
        }
        this._updateConfCallNotification();
    },

    _hasUnsentMessages: function(room) {
        return this._getUnsentMessages(room).length > 0;
    },

    _getUnsentMessages: function(room) {
        if (!room) { return []; }
        // TODO: It would be nice if the JS SDK provided nicer constant-time
        // constructs rather than O(N) (N=num msgs) on this.
        return room.timeline.filter(function(ev) {
            return ev.status === Matrix.EventStatus.NOT_SENT;
        });
    },

    _updateConfCallNotification: function() {
        var room = MatrixClientPeg.get().getRoom(this.props.roomId);
        if (!room || !this.props.ConferenceHandler) {
            return;
        }
        var confMember = room.getMember(
            this.props.ConferenceHandler.getConferenceUserIdForRoom(this.props.roomId)
        );

        if (!confMember) {
            return;
        }
        var confCall = this.props.ConferenceHandler.getConferenceCallForRoom(confMember.roomId);

        // A conf call notification should be displayed if there is an ongoing
        // conf call but this cilent isn't a part of it.
        this.setState({
            displayConfCallNotification: (
                (!confCall || confCall.call_state === "ended") &&
                confMember.membership === "join"
            )
        });
    },

    componentDidMount: function() {
        if (this.refs.messagePanel) {
            this._initialiseMessagePanel();
        }

        var call = CallHandler.getCallForRoom(this.props.roomId);
        var callState = call ? call.call_state : "ended";
        this.setState({
            callState: callState
        });

        this._updateConfCallNotification();

        window.addEventListener('resize', this.onResize);
        this.onResize();

        this._updateTabCompleteList(this.state.room);
    },

    _updateTabCompleteList: function(room) {
        if (!room || !this.tabComplete) {
            return;
        }
        this.tabComplete.setCompletionList(
            MemberEntry.fromMemberList(room.getJoinedMembers())
        );
    },

    _initialiseMessagePanel: function() {
        var messagePanel = ReactDOM.findDOMNode(this.refs.messagePanel);
        this.refs.messagePanel.initialised = true;

        messagePanel.addEventListener('drop', this.onDrop);
        messagePanel.addEventListener('dragover', this.onDragOver);
        messagePanel.addEventListener('dragleave', this.onDragLeaveOrEnd);
        messagePanel.addEventListener('dragend', this.onDragLeaveOrEnd);

        this.scrollToBottom();
        this.sendReadReceipt();

        this.refs.messagePanel.checkFillState();
    },

    componentDidUpdate: function() {
        // we need to initialise the messagepanel if we've just joined the
        // room. TODO: we really really ought to factor out messagepanel to a
        // separate component to avoid this ridiculous dance.
        if (!this.refs.messagePanel) return;

        if (!this.refs.messagePanel.initialised) {
            this._initialiseMessagePanel();
        }
    },

    _paginateCompleted: function() {
        if (DEBUG_SCROLL) console.log("paginate complete");

        this.setState({
            room: MatrixClientPeg.get().getRoom(this.props.roomId)
        });

        this.setState({paginating: false});

        // we might not have got enough (or, indeed, any) results from the
        // pagination request, so give the messagePanel a chance to set off
        // another.

        if (this.refs.messagePanel) {
            this.refs.messagePanel.checkFillState();
        }
    },

    onSearchResultsFillRequest: function(backwards) {
        if (!backwards || this.state.searchInProgress)
            return;

        if (this.nextSearchBatch) {
            if (DEBUG_SCROLL) console.log("requesting more search results");
            this._getSearchBatch(this.state.searchTerm,
                                 this.state.searchScope);
        } else {
            if (DEBUG_SCROLL) console.log("no more search results");
        }
    },

    // set off a pagination request.
    onMessageListFillRequest: function(backwards) {
        if (!backwards || this.state.paginating)
            return;

        // Either wind back the message cap (if there are enough events in the
        // timeline to do so), or fire off a pagination request.

        if (this.state.messageCap < this.state.room.timeline.length) {
            var cap = Math.min(this.state.messageCap + PAGINATE_SIZE, this.state.room.timeline.length);
            if (DEBUG_SCROLL) console.log("winding back message cap to", cap);
            this.setState({messageCap: cap});
        } else if(this.state.room.oldState.paginationToken) {
            var cap = this.state.messageCap + PAGINATE_SIZE;
            if (DEBUG_SCROLL) console.log("starting paginate to cap", cap);
            this.setState({messageCap: cap, paginating: true});
            MatrixClientPeg.get().scrollback(this.state.room, PAGINATE_SIZE).finally(this._paginateCompleted).done();
        }
    },

    // return true if there's more messages in the backlog which we aren't displaying
    _canPaginate: function() {
        return (this.state.messageCap < this.state.room.timeline.length) ||
            this.state.room.oldState.paginationToken;
    },

    onResendAllClick: function() {
        var eventsToResend = this._getUnsentMessages(this.state.room);
        eventsToResend.forEach(function(event) {
            Resend.resend(event);
        });
    },

    onJoinButtonClicked: function(ev) {
        var self = this;
        MatrixClientPeg.get().joinRoom(this.props.roomId).then(function() {
            self.setState({
                joining: false,
                room: MatrixClientPeg.get().getRoom(self.props.roomId)
            });
        }, function(error) {
            self.setState({
                joining: false,
                joinError: error
            });
        });
        this.setState({
            joining: true
        });
    },

    onMessageListScroll: function(ev) {
        if (this.state.numUnreadMessages != 0 &&
                this.refs.messagePanel.isAtBottom()) {
            this.setState({numUnreadMessages: 0});
        }
    },

    onDragOver: function(ev) {
        ev.stopPropagation();
        ev.preventDefault();

        ev.dataTransfer.dropEffect = 'none';

        var items = ev.dataTransfer.items;
        if (items.length == 1) {
            if (items[0].kind == 'file') {
                this.setState({ draggingFile : true });
                ev.dataTransfer.dropEffect = 'copy';
            }
        }
    },

    onDrop: function(ev) {
        ev.stopPropagation();
        ev.preventDefault();
        this.setState({ draggingFile : false });
        var files = ev.dataTransfer.files;
        if (files.length == 1) {
            this.uploadFile(files[0]);
        }
    },

    onDragLeaveOrEnd: function(ev) {
        ev.stopPropagation();
        ev.preventDefault();
        this.setState({ draggingFile : false });
    },

    uploadFile: function(file) {
        var self = this;
        ContentMessages.sendContentToRoom(
            file, this.props.roomId, MatrixClientPeg.get()
        ).done(undefined, function(error) {
            var ErrorDialog = sdk.getComponent("dialogs.ErrorDialog");
            Modal.createDialog(ErrorDialog, {
                title: "Failed to upload file",
                description: error.toString()
            });
        });
    },

    getWhoIsTypingString: function() {
        return WhoIsTyping.whoIsTypingString(this.state.room);
    },

    onSearch: function(term, scope) {
        this.setState({
            searchTerm: term,
            searchScope: scope,
            searchResults: [],
            searchHighlights: [],
            searchCount: null,
            searchCanPaginate: null,
        });

        // if we already have a search panel, we need to tell it to forget
        // about its scroll state.
        if (this.refs.searchResultsPanel) {
            this.refs.searchResultsPanel.resetScrollState();
        }

        this.nextSearchBatch = null;
        this._getSearchBatch(term, scope);
    },

    // fire off a request for a batch of search results
    _getSearchBatch: function(term, scope) {
        this.setState({
            searchInProgress: true,
        });

        // make sure that we don't end up merging results from
        // different searches by keeping a unique id.
        //
        // todo: should cancel any previous search requests.
        var searchId = this.searchId = new Date().getTime();

        var self = this;

        if (DEBUG_SCROLL) console.log("sending search request");
        MatrixClientPeg.get().search({ body: this._getSearchCondition(term, scope),
                                       next_batch: this.nextSearchBatch })
        .then(function(data) {
            if (DEBUG_SCROLL) console.log("search complete");
            if (!self.state.searching || self.searchId != searchId) {
                console.error("Discarding stale search results");
                return;
            }

            var results = data.search_categories.room_events;

            // postgres on synapse returns us precise details of the
            // strings which actually got matched for highlighting.

            // combine the highlight list with our existing list; build an object
            // to avoid O(N^2) fail
            var highlights = {};
            results.highlights.forEach(function(hl) { highlights[hl] = 1; });
            self.state.searchHighlights.forEach(function(hl) { highlights[hl] = 1; });

            // turn it back into an ordered list. For overlapping highlights,
            // favour longer (more specific) terms first
            highlights = Object.keys(highlights).sort(function(a, b) { b.length - a.length });

            // sqlite doesn't give us any highlights, so just try to highlight the literal search term
            if (highlights.length == 0) {
                highlights = [ term ];
            }

            // append the new results to our existing results
            var events = self.state.searchResults.concat(results.results);

            self.setState({
                searchHighlights: highlights,
                searchResults: events,
                searchCount: results.count,
                searchCanPaginate: !!(results.next_batch),
            });
            self.nextSearchBatch = results.next_batch;
        }, function(error) {
            var ErrorDialog = sdk.getComponent("dialogs.ErrorDialog");
            Modal.createDialog(ErrorDialog, {
                title: "Search failed",
                description: error.toString()
            });
        }).finally(function() {
            self.setState({
                searchInProgress: false
            });
        }).done();
    },

    _getSearchCondition: function(term, scope) {
        var filter;

        if (scope === "Room") {
            filter = {
                // XXX: it's unintuitive that the filter for searching doesn't have the same shape as the v2 filter API :(
                rooms: [
                    this.props.roomId
                ]
            };
        }

        return {
            search_categories: {
                room_events: {
                    search_term: term,
                    filter: filter,
                    order_by: "recent",
                    event_context: {
                        before_limit: 1,
                        after_limit: 1,
                        include_profile: true,
                    }
                }
            }
        }
    },

    getSearchResultTiles: function() {
        var DateSeparator = sdk.getComponent('messages.DateSeparator');
        var cli = MatrixClientPeg.get();

        var ret = [];

        var EventTile = sdk.getComponent('rooms.EventTile');

        // XXX: todo: merge overlapping results somehow?
        // XXX: why doesn't searching on name work?


        if (this.state.searchCanPaginate === false) {
            if (this.state.searchResults.length == 0) {
                ret.push(<li key="search-top-marker">
                         <h2 className="mx_RoomView_topMarker">No results</h2>
                         </li>
                        );
            } else {
                ret.push(<li key="search-top-marker">
                         <h2 className="mx_RoomView_topMarker">No more results</h2>
                         </li>
                        );
            }
        }

        var lastRoomId;

        for (var i = this.state.searchResults.length - 1; i >= 0; i--) {
            var result = this.state.searchResults[i];
            var mxEv = new Matrix.MatrixEvent(result.result);

            if (!EventTile.haveTileForEvent(mxEv)) {
                // XXX: can this ever happen? It will make the result count
                // not match the displayed count.
                continue;
            }

            var eventId = mxEv.getId();

            if (this.state.searchScope === 'All') {
                var roomId = result.result.room_id;
                if(roomId != lastRoomId) {
                    ret.push(<li key={eventId + "-room"}><h1>Room: { cli.getRoom(roomId).name }</h1></li>);
                    lastRoomId = roomId;
                }
            }

            var ts1 = result.result.origin_server_ts;
            ret.push(<li key={ts1 + "-search"}><DateSeparator ts={ts1}/></li>); // Rank: {resultList[i].rank}

            if (result.context.events_before[0]) {
                var mxEv2 = new Matrix.MatrixEvent(result.context.events_before[0]);
                if (EventTile.haveTileForEvent(mxEv2)) {
                    ret.push(<li key={eventId+"-1"} data-scroll-token={eventId+"-1"}><EventTile mxEvent={mxEv2} contextual={true} /></li>);
                }
            }

            ret.push(<li key={eventId+"+0"} data-scroll-token={eventId+"+0"}><EventTile mxEvent={mxEv} highlights={this.state.searchHighlights}/></li>);

            if (result.context.events_after[0]) {
                var mxEv2 = new Matrix.MatrixEvent(result.context.events_after[0]);
                if (EventTile.haveTileForEvent(mxEv2)) {
                    ret.push(<li key={eventId+"+1"} data-scroll-token={eventId+"+1"}><EventTile mxEvent={mxEv2} contextual={true} /></li>);
                }
            }
        }
        return ret;
    },

    getEventTiles: function() {
        var DateSeparator = sdk.getComponent('messages.DateSeparator');

        var ret = [];
        var count = 0;

        var EventTile = sdk.getComponent('rooms.EventTile');


        var prevEvent = null; // the last event we showed
        var startIdx = Math.max(0, this.state.room.timeline.length - this.state.messageCap);
        for (var i = startIdx; i < this.state.room.timeline.length; i++) {
            var mxEv = this.state.room.timeline[i];

            if (!EventTile.haveTileForEvent(mxEv)) {
                continue;
            }
            if (this.props.ConferenceHandler && mxEv.getType() === "m.room.member") {
                if (this.props.ConferenceHandler.isConferenceUser(mxEv.getSender()) ||
                        this.props.ConferenceHandler.isConferenceUser(mxEv.getStateKey())) {
                    continue; // suppress conf user join/parts
                }
            }

            // is this a continuation of the previous message?
            var continuation = false;
            if (prevEvent !== null) {
                if (mxEv.sender &&
                    prevEvent.sender &&
                    (mxEv.sender.userId === prevEvent.sender.userId) &&
                    (mxEv.getType() == prevEvent.getType())
                    )
                {
                    continuation = true;
                }
            }

            // do we need a date separator since the last event?
            var ts1 = mxEv.getTs();
            if ((prevEvent == null && !this._canPaginate()) ||
                (prevEvent != null &&
                 new Date(prevEvent.getTs()).toDateString() !== new Date(ts1).toDateString())) {
                var dateSeparator = <li key={ts1}><DateSeparator key={ts1} ts={ts1}/></li>;
                ret.push(dateSeparator);
                continuation = false;
            }

            var last = false;
            if (i == this.state.room.timeline.length - 1) {
                // XXX: we might not show a tile for the last event.
                last = true;
            }

            var eventId = mxEv.getId();
            ret.push(
                <li key={eventId} ref={this._collectEventNode.bind(this, eventId)} data-scroll-token={eventId}>
                    <EventTile mxEvent={mxEv} continuation={continuation} last={last}/>
                </li>
            );

            prevEvent = mxEv;
        }

        return ret;
    },

    uploadNewState: function(new_name, new_topic, new_join_rule, new_history_visibility, new_power_levels) {
        var old_name = this.state.room.name;

        var old_topic = this.state.room.currentState.getStateEvents('m.room.topic', '');
        if (old_topic) {
            old_topic = old_topic.getContent().topic;
        } else {
            old_topic = "";
        }

        var old_join_rule = this.state.room.currentState.getStateEvents('m.room.join_rules', '');
        if (old_join_rule) {
            old_join_rule = old_join_rule.getContent().join_rule;
        } else {
            old_join_rule = "invite";
        }

        var old_history_visibility = this.state.room.currentState.getStateEvents('m.room.history_visibility', '');
        if (old_history_visibility) {
            old_history_visibility = old_history_visibility.getContent().history_visibility;
        } else {
            old_history_visibility = "shared";
        }

        var deferreds = [];

        if (old_name != new_name && new_name != undefined && new_name) {
            deferreds.push(
                MatrixClientPeg.get().setRoomName(this.state.room.roomId, new_name)
            );
        }

        if (old_topic != new_topic && new_topic != undefined) {
            deferreds.push(
                MatrixClientPeg.get().setRoomTopic(this.state.room.roomId, new_topic)
            );
        }

        if (old_join_rule != new_join_rule && new_join_rule != undefined) {
            deferreds.push(
                MatrixClientPeg.get().sendStateEvent(
                    this.state.room.roomId, "m.room.join_rules", {
                        join_rule: new_join_rule,
                    }, ""
                )
            );
        }

        if (old_history_visibility != new_history_visibility && new_history_visibility != undefined) {
            deferreds.push(
                MatrixClientPeg.get().sendStateEvent(
                    this.state.room.roomId, "m.room.history_visibility", {
                        history_visibility: new_history_visibility,
                    }, ""
                )
            );
        }

        if (new_power_levels) {
            deferreds.push(
                MatrixClientPeg.get().sendStateEvent(
                    this.state.room.roomId, "m.room.power_levels", new_power_levels, ""
                )
            );
        }

        if (deferreds.length) {
            var self = this;
            q.all(deferreds).fail(function(err) {
                var ErrorDialog = sdk.getComponent("dialogs.ErrorDialog");
                Modal.createDialog(ErrorDialog, {
                    title: "Failed to set state",
                    description: err.toString()
                });
            }).finally(function() {
                self.setState({
                    uploadingRoomSettings: false,
                });
            });
        } else {
            this.setState({
                editingRoomSettings: false,
                uploadingRoomSettings: false,
            });
        }
    },

    _collectEventNode: function(eventId, node) {
        if (this.eventNodes == undefined) this.eventNodes = {};
        this.eventNodes[eventId] = node;
    },

    _indexForEventId(evId) {
        for (var i = 0; i < this.state.room.timeline.length; ++i) {
            if (evId == this.state.room.timeline[i].getId()) {
                return i;
            }
        }
        return null;
    },

    sendReadReceipt: function() {
        if (!this.state.room) return;
        var currentReadUpToEventId = this.state.room.getEventReadUpTo(MatrixClientPeg.get().credentials.userId);
        var currentReadUpToEventIndex = this._indexForEventId(currentReadUpToEventId);

        var lastReadEventIndex = this._getLastDisplayedEventIndexIgnoringOwn();
        if (lastReadEventIndex === null) return;

        if (lastReadEventIndex > currentReadUpToEventIndex) {
            MatrixClientPeg.get().sendReadReceipt(this.state.room.timeline[lastReadEventIndex]);
        }
    },

    _getLastDisplayedEventIndexIgnoringOwn: function() {
        if (this.eventNodes === undefined) return null;

        var messageWrapper = this.refs.messagePanel;
        if (messageWrapper === undefined) return null;
        var wrapperRect = ReactDOM.findDOMNode(messageWrapper).getBoundingClientRect();

        for (var i = this.state.room.timeline.length-1; i >= 0; --i) {
            var ev = this.state.room.timeline[i];

            if (ev.sender && ev.sender.userId == MatrixClientPeg.get().credentials.userId) {
                continue;
            }

            var node = this.eventNodes[ev.getId()];
            if (!node) continue;

            var boundingRect = node.getBoundingClientRect();

            if (boundingRect.bottom < wrapperRect.bottom) {
                return i;
            }
        }
        return null;
    },

    onSettingsClick: function() {
        this.setState({editingRoomSettings: true});
    },

    onSaveClick: function() {
        this.setState({
            editingRoomSettings: false,
            uploadingRoomSettings: true,
        });

        var new_name = this.refs.header.getRoomName();
        var new_topic = this.refs.room_settings.getTopic();
        var new_join_rule = this.refs.room_settings.getJoinRules();
        var new_history_visibility = this.refs.room_settings.getHistoryVisibility();
        var new_power_levels = this.refs.room_settings.getPowerLevels();

        this.uploadNewState(
            new_name,
            new_topic,
            new_join_rule,
            new_history_visibility,
            new_power_levels
        );
    },

    onCancelClick: function() {
        this.setState({editingRoomSettings: false});
    },

    onLeaveClick: function() {
        dis.dispatch({
            action: 'leave_room',
            room_id: this.props.roomId,
        });
    },

    onForgetClick: function() {
        MatrixClientPeg.get().forget(this.props.roomId).done(function() {
            dis.dispatch({ action: 'view_next_room' });
        }, function(err) {
            var errCode = err.errcode || "unknown error code";
            var ErrorDialog = sdk.getComponent("dialogs.ErrorDialog");
            Modal.createDialog(ErrorDialog, {
                title: "Error",
                description: `Failed to forget room (${errCode})`
            });
        });
    },

    onRejectButtonClicked: function(ev) {
        var self = this;
        this.setState({
            rejecting: true
        });
        MatrixClientPeg.get().leave(this.props.roomId).done(function() {
            dis.dispatch({ action: 'view_next_room' });
            self.setState({
                rejecting: false
            });
        }, function(err) {
            console.error("Failed to reject invite: %s", err);
            self.setState({
                rejecting: false,
                rejectError: err
            });
        });
    },

    onSearchClick: function() {
        this.setState({ searching: true });
    },

    onCancelSearchClick: function () {
        this.setState({
            searching: false,
            searchResults: null,
        });
    },

    onConferenceNotificationClick: function() {
        dis.dispatch({
            action: 'place_call',
            type: "video",
            room_id: this.props.roomId
        });
    },

    getUnreadMessagesString: function() {
        if (!this.state.numUnreadMessages) {
            return "";
        }
        return this.state.numUnreadMessages + " new message" + (this.state.numUnreadMessages > 1 ? "s" : "");
    },

    scrollToBottom: function() {
        var messagePanel = this.refs.messagePanel;
        if (!messagePanel) return;
        messagePanel.scrollToBottom();
    },

    // scroll the event view to put the given event at the bottom.
    //
    // pixel_offset gives the number of pixels between the bottom of the event
    // and the bottom of the container.
    scrollToEvent: function(eventId, pixelOffset) {
        var messagePanel = this.refs.messagePanel;
        if (!messagePanel) return;

        var idx = this._indexForEventId(eventId);
        if (idx === null) {
            // we don't seem to have this event in our timeline. Presumably
            // it's fallen out of scrollback. We ought to backfill until we
            // find it, but we'd have to be careful we didn't backfill forever
            // looking for a non-existent event.
            //
            // for now, just scroll to the top of the buffer.
            console.log("Refusing to scroll to unknown event "+eventId);
            messagePanel.scrollToTop();
            return;
        }

        // we might need to roll back the messagecap (to generate tiles for
        // older messages). This just means telling getEventTiles to create
        // tiles for events we already have in our timeline (we already know
        // the event in question is in our timeline, so we shouldn't need to
        // backfill).
        //
        // we actually wind back slightly further than the event in question,
        // because we want the event to be at the *bottom* of the container.
        // Don't roll it back past the timeline we have, though.
        var minCap = this.state.room.timeline.length - Math.min(idx - INITIAL_SIZE, 0);
        if (minCap > this.state.messageCap) {
            this.setState({messageCap: minCap});
        }

        // the scrollTokens on our DOM nodes are the event IDs, so we can pass
        // eventId directly into _scrollToToken.
        messagePanel.scrollToToken(eventId, pixelOffset);
    },

    // get the current scroll position of the room, so that it can be
    // restored when we switch back to it
    getScrollState: function() {
        var messagePanel = this.refs.messagePanel;
        if (!messagePanel) return null;

        return messagePanel.getScrollState();
    },

    restoreScrollState: function(scrollState) {
        var messagePanel = this.refs.messagePanel;
        if (!messagePanel) return null;

        if(scrollState.atBottom) {
            // we were at the bottom before. Ideally we'd scroll to the
            // 'read-up-to' mark here.
            messagePanel.scrollToBottom();

        } else if (scrollState.lastDisplayedScrollToken) {
            // we might need to backfill, so we call scrollToEvent rather than
            // scrollToToken here. The scrollTokens on our DOM nodes are the
            // event IDs, so lastDisplayedScrollToken will be the event ID we need,
            // and we can pass it directly into scrollToEvent.
            this.scrollToEvent(scrollState.lastDisplayedScrollToken,
                               scrollState.pixelOffset);
        }
    },

    onResize: function(e) {
        // It seems flexbox doesn't give us a way to constrain the auxPanel height to have
        // a minimum of the height of the video element, whilst also capping it from pushing out the page
        // so we have to do it via JS instead.  In this implementation we cap the height by putting
        // a maxHeight on the underlying remote video tag.
        var auxPanelMaxHeight;
        if (this.refs.callView) {
            // XXX: don't understand why we have to call findDOMNode here in react 0.14 - it should already be a DOM node.
            var video = ReactDOM.findDOMNode(this.refs.callView.refs.video.refs.remote);

            // header + footer + status + give us at least 100px of scrollback at all times.
            auxPanelMaxHeight = window.innerHeight - (83 + 72 + 36 + 100);

            // XXX: this is a bit of a hack and might possibly cause the video to push out the page anyway
            // but it's better than the video going missing entirely
            if (auxPanelMaxHeight < 50) auxPanelMaxHeight = 50;

            video.style.maxHeight = auxPanelMaxHeight + "px";
        }
    },

    onFullscreenClick: function() {
        dis.dispatch({
            action: 'video_fullscreen',
            fullscreen: true
        }, true);
    },

    onMuteAudioClick: function() {
        var call = CallHandler.getCallForRoom(this.props.roomId);
        if (!call) {
            return;
        }
        var newState = !call.isMicrophoneMuted();
        call.setMicrophoneMuted(newState);
        this.setState({
            audioMuted: newState
        });
    },

    onMuteVideoClick: function() {
        var call = CallHandler.getCallForRoom(this.props.roomId);
        if (!call) {
            return;
        }
        var newState = !call.isLocalVideoMuted();
        call.setLocalVideoMuted(newState);
        this.setState({
            videoMuted: newState
        });
    },

    onSvgLoad: function(event) {
        dis.dispatch({ action: "svg_onload", svg: event.target });
    },

    render: function() {
        var RoomHeader = sdk.getComponent('rooms.RoomHeader');
        var MessageComposer = sdk.getComponent('rooms.MessageComposer');
        var CallView = sdk.getComponent("voip.CallView");
        var RoomSettings = sdk.getComponent("rooms.RoomSettings");
        var SearchBar = sdk.getComponent("rooms.SearchBar");
        var ScrollPanel = sdk.getComponent("structures.ScrollPanel");

        if (!this.state.room) {
            if (this.props.roomId) {
                return (
                    <div>
                    <button onClick={this.onJoinButtonClicked}>Join Room</button>
                    </div>
                );
            } else {
                return (
                    <div />
                );
            }
        }

        var myUserId = MatrixClientPeg.get().credentials.userId;
        var myMember = this.state.room.getMember(myUserId);
        if (myMember && myMember.membership == 'invite') {
            if (this.state.joining || this.state.rejecting) {
                var Loader = sdk.getComponent("elements.Spinner");
                return (
                    <div className="mx_RoomView">
                        <Loader />
                    </div>
                );
            } else {
                var inviteEvent = myMember.events.member;
                var inviterName = inviteEvent.sender ? inviteEvent.sender.name : inviteEvent.getSender();
                // XXX: Leaving this intentionally basic for now because invites are about to change totally
                var joinErrorText = this.state.joinError ? "Failed to join room!" : "";
                var rejectErrorText = this.state.rejectError ? "Failed to reject invite!" : "";
                return (
                    <div className="mx_RoomView">
                        <RoomHeader ref="header" room={this.state.room} simpleHeader="Room invite"/>
                        <div className="mx_RoomView_invitePrompt">
                            <div>{inviterName} has invited you to a room</div>
                            <br/>
                            <button ref="joinButton" onClick={this.onJoinButtonClicked}>Join</button>
                            <button onClick={this.onRejectButtonClicked}>Reject</button>
                            <div className="error">{joinErrorText}</div>
                            <div className="error">{rejectErrorText}</div>
                        </div>
                    </div>
                );
            }
        } else {
            var scrollheader_classes = classNames({
                mx_RoomView_scrollheader: true,
                loading: this.state.paginating
            });

            var statusBar;

            // for testing UI...
            // this.state.upload = {
            //     uploadedBytes: 123493,
            //     totalBytes: 347534,
            //     fileName: "testing_fooble.jpg",
            // }

            if (ContentMessages.getCurrentUploads().length > 0) {
                var UploadBar = sdk.getComponent('structures.UploadBar');
                statusBar = <UploadBar room={this.state.room} />
            } else if (!this.state.searchResults) {
                var typingString = this.getWhoIsTypingString();
                // typingString = "S͚͍̭̪̤͙̱͙̖̥͙̥̤̻̙͕͓͂̌ͬ͐̂k̜̝͎̰̥̻̼̂̌͛͗͊̅̒͂̊̍̍͌̈̈́͌̋̊ͬa͉̯͚̺̗̳̩ͪ̋̑͌̓̆̍̂̉̏̅̆ͧ̌̑v̲̲̪̝ͥ̌ͨͮͭ̊͆̾ͮ̍ͮ͑̚e̮̙͈̱̘͕̼̮͒ͩͨͫ̃͗̇ͩ͒ͣͦ͒̄̍͐ͣ̿ͥṘ̗̺͇̺̺͔̄́̊̓͊̍̃ͨ̚ā̼͎̘̟̼͎̜̪̪͚̋ͨͨͧ̓ͦͯͤ̄͆̋͂ͩ͌ͧͅt̙̙̹̗̦͖̞ͫͪ͑̑̅ͪ̃̚ͅ is typing...";
                var unreadMsgs = this.getUnreadMessagesString();
                // no conn bar trumps unread count since you can't get unread messages
                // without a connection! (technically may already have some but meh)
                // It also trumps the "some not sent" msg since you can't resend without
                // a connection!
                if (this.state.syncState === "ERROR") {
                    statusBar = (
                        <div className="mx_RoomView_connectionLostBar">
                            <img src="img/warning.svg" width="24" height="23" title="/!\ " alt="/!\ "/>
                            <div className="mx_RoomView_connectionLostBar_textArea">
                                <div className="mx_RoomView_connectionLostBar_title">
                                    Connectivity to the server has been lost.
                                </div>
                                <div className="mx_RoomView_connectionLostBar_desc">
                                    Sent messages will be stored until your connection has returned.
                                </div>
                            </div>
                        </div>
                    );
                }
                else if (this.tabComplete.isTabCompleting()) {
                    var TabCompleteBar = sdk.getComponent('rooms.TabCompleteBar');
                    statusBar = (
                        <div className="mx_RoomView_tabCompleteBar">
                            <div className="mx_RoomView_tabCompleteImage">...</div>
                            <div className="mx_RoomView_tabCompleteWrapper">
                                <TabCompleteBar entries={this.tabComplete.peek(6)} />
                                <div className="mx_RoomView_tabCompleteEol" title="->|">
                                    <object onLoad={ this.onSvgLoad } className="mx_Svg" type="image/svg+xml" data="img/eol.svg" width="22" height="16"/>
                                    Auto-complete
                                </div>
                            </div>
                        </div>
                    );
                }
                else if (this.state.hasUnsentMessages) {
                    statusBar = (
                        <div className="mx_RoomView_connectionLostBar">
                            <img src="img/warning.svg" width="24" height="23" title="/!\ " alt="/!\ "/>
                            <div className="mx_RoomView_connectionLostBar_textArea">
                                <div className="mx_RoomView_connectionLostBar_title">
                                    Some of your messages have not been sent.
                                </div>
                                <div className="mx_RoomView_connectionLostBar_desc">
                                    <a className="mx_RoomView_resend_link"
                                        onClick={ this.onResendAllClick }>
                                    Resend all now
                                    </a> or select individual messages to re-send.
                                </div>
                            </div>
                        </div>
                    );
                }
                // unread count trumps who is typing since the unread count is only
                // set when you've scrolled up
                else if (unreadMsgs) {
                    statusBar = (
                        <div className="mx_RoomView_unreadMessagesBar" onClick={ this.scrollToBottom }>
                            <img src="img/newmessages.png" width="24" height="24" alt=""/>
                            {unreadMsgs}
                        </div>
                    );
                }
                else if (typingString) {
                    statusBar = (
                        <div className="mx_RoomView_typingBar">
                            <div className="mx_RoomView_typingImage">...</div>
                            <span className="mx_RoomView_typingText">{typingString}</span>
                        </div>
                    );
                }
            }

            var aux = null;
            if (this.state.editingRoomSettings) {
                aux = <RoomSettings ref="room_settings" onSaveClick={this.onSaveClick} room={this.state.room} />;
            }
            else if (this.state.uploadingRoomSettings) {
                var Loader = sdk.getComponent("elements.Spinner");                
                aux = <Loader/>;
            }
            else if (this.state.searching) {
                aux = <SearchBar ref="search_bar" searchInProgress={this.state.searchInProgress } onCancelClick={this.onCancelSearchClick} onSearch={this.onSearch}/>;
            }

            var conferenceCallNotification = null;
            if (this.state.displayConfCallNotification) {
                var supportedText;
                if (!MatrixClientPeg.get().supportsVoip()) {
                    supportedText = " (unsupported)";
                }
                conferenceCallNotification = (
                    <div className="mx_RoomView_ongoingConfCallNotification" onClick={this.onConferenceNotificationClick}>
                        Ongoing conference call {supportedText}
                    </div>
                );
            }

            var fileDropTarget = null;
            if (this.state.draggingFile) {
                fileDropTarget = <div className="mx_RoomView_fileDropTarget">
                                    <div className="mx_RoomView_fileDropTargetLabel" title="Drop File Here">
                                        <object onLoad={ this.onSvgLoad } className="mx_Svg" type="image/svg+xml" data="img/upload-big.svg" width="45" height="59"/><br/>
                                        Drop File Here
                                    </div>
                                 </div>;
            }

            var messageComposer, searchInfo;
            var canSpeak = (
                // joined and not showing search results
                myMember && (myMember.membership == 'join') && !this.state.searchResults
            );
            if (canSpeak) {
                messageComposer =
                    <MessageComposer
                        room={this.state.room} roomView={this} uploadFile={this.uploadFile}
                        callState={this.state.callState} tabComplete={this.tabComplete} />
            }

            // TODO: Why aren't we storing the term/scope/count in this format
            // in this.state if this is what RoomHeader desires?
            if (this.state.searchResults) {
                searchInfo = {
                    searchTerm : this.state.searchTerm,
                    searchScope : this.state.searchScope,
                    searchCount : this.state.searchCount,
                };
            }

            var call = CallHandler.getCallForRoom(this.props.roomId);
            //var call = CallHandler.getAnyActiveCall();
            var inCall = false;
            if (call && (this.state.callState !== 'ended' && this.state.callState !== 'ringing')) {
                inCall = true;
                var zoomButton, voiceMuteButton, videoMuteButton;

                if (call.type === "video") {
                    zoomButton = (
                        <div className="mx_RoomView_voipButton" onClick={this.onFullscreenClick} title="Fill screen">
                            <object onLoad={ this.onSvgLoad } className="mx_Svg" type="image/svg+xml" data="img/fullscreen.svg" width="29" height="22" style={{ marginTop: 1, marginRight: 4 }}/>
                        </div>
                    );

                    videoMuteButton =
                        <div className="mx_RoomView_voipButton" onClick={this.onMuteVideoClick}>
                            <img src={call.isLocalVideoMuted() ? "img/video-unmute.svg" : "img/video-mute.svg"}
                                 alt={call.isLocalVideoMuted() ? "Click to unmute video" : "Click to mute video"}
                                 width="31" height="27"/>
                        </div>
                }
                voiceMuteButton =
                    <div className="mx_RoomView_voipButton" onClick={this.onMuteAudioClick}>
                        <img src={call.isMicrophoneMuted() ? "img/voice-unmute.svg" : "img/voice-mute.svg"} 
                             alt={call.isMicrophoneMuted() ? "Click to unmute audio" : "Click to mute audio"} 
                             width="21" height="26"/>
                    </div>

                if (!statusBar) {
                    statusBar =
                        <div className="mx_RoomView_callBar">
                            <img src="img/sound-indicator.svg" width="23" height="20"/>
                            <b>Active call</b>
                        </div>;
                }

                statusBar =
                    <div className="mx_RoomView_callStatusBar">
                        { voiceMuteButton }
                        { videoMuteButton }
                        { zoomButton }
                        { statusBar }
                        <object onLoad={ this.onSvgLoad } className="mx_Svg" type="image/svg+xml" className="mx_RoomView_voipChevron" data="img/voip-chevron.svg" width="22" height="17"/>
                    </div>
            }


            // if we have search results, we keep the messagepanel (so that it preserves its
            // scroll state), but hide it.
            var searchResultsPanel;
            var hideMessagePanel = false;

            if (this.state.searchResults) {
                searchResultsPanel = (
                    <ScrollPanel ref="searchResultsPanel" className="mx_RoomView_messagePanel"
                            onFillRequest={ this.onSearchResultsFillRequest }>
                        <li className={scrollheader_classes}></li>
                        {this.getSearchResultTiles()}
                    </ScrollPanel>
                );
                hideMessagePanel = true;
            }

            var messagePanel = (
                    <ScrollPanel ref="messagePanel" className="mx_RoomView_messagePanel"
                            onScroll={ this.onMessageListScroll } 
                            onFillRequest={ this.onMessageListFillRequest }
                            style={ hideMessagePanel ? { display: 'none' } : {} } >
                        <li className={scrollheader_classes}></li>
                        {this.getEventTiles()}
                    </ScrollPanel>
            );

            return (
                <div className={ "mx_RoomView" + (inCall ? " mx_RoomView_inCall" : "") }>
                    <RoomHeader ref="header" room={this.state.room} searchInfo={searchInfo}
                        editing={this.state.editingRoomSettings}
                        onSearchClick={this.onSearchClick}
                        onSettingsClick={this.onSettingsClick}
                        onSaveClick={this.onSaveClick}
                        onCancelClick={this.onCancelClick}
                        onForgetClick={
                            (myMember && myMember.membership === "leave") ? this.onForgetClick : null
                        }
                        onLeaveClick={
                            (myMember && myMember.membership === "join") ? this.onLeaveClick : null
                        } />
                    { fileDropTarget }    
                    <div className="mx_RoomView_auxPanel">
                        <CallView ref="callView" room={this.state.room} ConferenceHandler={this.props.ConferenceHandler}/>
                        { conferenceCallNotification }
                        { aux }
                    </div>
                    { messagePanel }
                    { searchResultsPanel }
                    <div className="mx_RoomView_statusArea">
                        <div className="mx_RoomView_statusAreaBox">
                            <div className="mx_RoomView_statusAreaBox_line"></div>
                            { statusBar }
                        </div>
                    </div>
                    { messageComposer }
                </div>
            );
        }
    },
});
