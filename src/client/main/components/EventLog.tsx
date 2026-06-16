import { ArrowUp, ArrowDown } from "react-feather";
import { useState } from "react";
import React from "react";

interface RealtimeEvent {
  event_id?: string;
  type: string;
  timestamp?: string;
  [key: string]: unknown;
}

interface EventProps {
  event: RealtimeEvent;
  timestamp: string | undefined;
}

function Event({ event, timestamp }: EventProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const isClient = event.event_id && !event.event_id.startsWith("event_");

  return (
    <div className="flex flex-col gap-2 p-2 rounded-md bg-gray-50">
      <div
        className="flex items-center gap-2 cursor-pointer"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        {isClient ? (
          <ArrowDown className="text-blue-400" />
        ) : (
          <ArrowUp className="text-green-400" />
        )}
        <div className="text-sm text-gray-500">
          {isClient ? "client:" : "server:"}
          &nbsp;{event.type} | {timestamp}
        </div>
      </div>
      <div
        className={`text-gray-500 bg-gray-200 p-2 rounded-md overflow-x-auto ${
          isExpanded ? "block" : "hidden"
        }`}
      >
        <pre className="text-xs">{JSON.stringify(event, null, 2)}</pre>
      </div>
    </div>
  );
}

interface EventLogProps {
  events: RealtimeEvent[];
}

export default function EventLog({ events }: EventLogProps) {
  const eventsToDisplay: React.ReactElement[] = [];
  const deltaEvents: Record<string, RealtimeEvent> = {};

  events.forEach((event: RealtimeEvent) => {
    if (event.type.endsWith("delta")) {
      if (deltaEvents[event.type]) {
        // for now just log a single event per render pass
        return;
      } else {
        deltaEvents[event.type] = event;
      }
    }

    eventsToDisplay.push(
      <Event key={event.event_id} event={event} timestamp={event.timestamp} />,
    );
  });

  return (
    <div className="flex flex-col gap-2 overflow-x-auto">
      {events.length === 0 ? (
        <div className="text-gray-500">Awaiting events...</div>
      ) : (
        eventsToDisplay
      )}
    </div>
  );
}